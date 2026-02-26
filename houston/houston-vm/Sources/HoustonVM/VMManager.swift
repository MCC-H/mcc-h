import AppKit
import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import IOSurface
import Metal
import Virtualization

/// Virtual display resolution. 1920×1200 (16:10) regardless of VM console window size.
private let virtualDisplayWidth: Double = 1920
private let virtualDisplayHeight: Double = 1200

/// Display pixel density (PPI). ~92 matches a typical 24" Full HD monitor. Higher = smaller UI elements.
private let virtualDisplayPixelsPerInch: Int = 92

enum HoustonVMConstants {
    static var vmsDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("houston")
            .appendingPathComponent("VMs")
    }
    static var isosDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("houston")
            .appendingPathComponent("ISOs")
    }
    static var debianIsoPath: URL {
        isosDir.appendingPathComponent("debian-13.3.0-arm64-netinst.iso")
    }
    static let debianIsoUrl = URL(
        string:
            "https://cdimage.debian.org/debian-cd/current/arm64/iso-cd/debian-13.3.0-arm64-netinst.iso"
    )!
    static let diskSizeGb: UInt64 = 20
    static let macDiskSizeGb: UInt64 = 32
    static let vmRamMb: UInt64 = 4096
    static let vmCpus = 2
}

struct VMConfig: Codable {
    let id: String
    var name: String
    var ramMb: Int
    var diskGb: Int
    var guestType: String?  // "linux" | "macos", default linux
    var isoPath: String?
    var ipswPath: String?
    var macAddress: String?  // Persistent MAC for NAT-DHCP (same MAC -> same IP across restarts)
}

@MainActor
class HoustonVMManager {
    static let shared = HoustonVMManager()
    var runningVM:
        (
            id: String, vm: VZVirtualMachine, view: VZVirtualMachineView, automator: VZAutomator,
            delegate: VMDelegate, windowDelegate: VMWindowDelegate, serialHandle: FileHandle?
        )?
    var installingMacOS: [String: (progress: Progress, window: NSWindow)] = [:]
    var macOSCreatingProgress: [String: (phase: String, fractionCompleted: Double)] = [:]
    func installProgress(id: String) -> (fractionCompleted: Double, phase: String)? {
        if let entry = macOSCreatingProgress[id] {
            return (entry.fractionCompleted, entry.phase)
        }
        guard let entry = installingMacOS[id] else { return nil }
        return (
            entry.progress.fractionCompleted, entry.progress.localizedDescription ?? "installing"
        )
    }

    private init() {}

    /// Returns a persistent MAC address for the VM. Reads from config if present; otherwise generates one and saves it.
    /// Same MAC across restarts -> NAT DHCP typically assigns the same IP.
    private func getOrCreateMacAddress(vmDir: URL) throws -> VZMACAddress {
        let configPath = vmDir.appendingPathComponent("config.json")
        var vmConfig: VMConfig?
        if let data = try? Data(contentsOf: configPath),
            let c = try? JSONDecoder().decode(VMConfig.self, from: data)
        {
            vmConfig = c
            if let macStr = c.macAddress, let addr = VZMACAddress(string: macStr) {
                return addr
            }
        }
        let mac = VZMACAddress.randomLocallyAdministered()
        let macString = mac.string
        guard var c = vmConfig else {
            return mac  // No config yet, use random but can't persist
        }
        c.macAddress = macString
        try? JSONEncoder().encode(c).write(to: configPath)
        print("[HoustonVM]   network: NAT with persistent MAC \(macString)")
        return mac
    }

    /// Returns guestType ("macos" | "linux") for a VM by id. Reads from config.json.
    func guestType(forVMId id: String) -> String {
        let vmDir = HoustonVMConstants.vmsDir.appendingPathComponent("Houston-\(id).vm")
        let configPath = vmDir.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: configPath),
            let config = try? JSONDecoder().decode(VMConfig.self, from: data)
        else { return "linux" }
        return config.guestType ?? "linux"
    }

    func listVMs() -> [[String: Any]] {
        var result: [[String: Any]] = []
        guard
            let entries = try? FileManager.default.contentsOfDirectory(
                at: HoustonVMConstants.vmsDir,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
        else { return result }

        for url in entries {
            guard (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
                continue
            }
            let name = url.lastPathComponent
            guard name.hasPrefix("Houston-"), name.hasSuffix(".vm") else { continue }
            let id =
                name
                .replacingOccurrences(of: "Houston-", with: "")
                .replacingOccurrences(of: ".vm", with: "")

            let configPath = url.appendingPathComponent("config.json")
            var ramMb = 2048
            var diskGb = 20
            var displayName = name
            var guestType = "linux"
            if let data = try? Data(contentsOf: configPath),
                let config = try? JSONDecoder().decode(VMConfig.self, from: data)
            {
                ramMb = config.ramMb
                diskGb = config.diskGb
                displayName = config.name
                guestType = config.guestType ?? "linux"
            }

            var status = runningVM?.id == id ? "running" : "stopped"
            if installingMacOS[id] != nil || macOSCreatingProgress[id] != nil {
                status = "installing"
            }
            result.append([
                "id": id,
                "name": displayName,
                "path": url.path,
                "status": status,
                "ramMb": ramMb,
                "diskGb": diskGb,
                "guestType": guestType,
            ])
        }

        return result.sorted { ($0["id"] as? String ?? "") < ($1["id"] as? String ?? "") }
    }

    func nextVMId() -> String {
        let existing = listVMs().compactMap { $0["id"] as? String }
        let ids = existing.compactMap { Int($0) }.filter { $0 > 0 }
        let next = ids.isEmpty ? 1 : (ids.max() ?? 0) + 1
        return String(format: "%02d", next)
    }

    func createVM(
        guestType: String = "linux", isoPath: String? = nil, ipswPath: String? = nil,
        ramMb: Int? = nil, diskGb: Int? = nil
    ) throws -> [String: Any] {
        try FileManager.default.createDirectory(
            at: HoustonVMConstants.vmsDir, withIntermediateDirectories: true)
        let id = nextVMId()
        let name = "Houston-\(id)"
        let vmDir = HoustonVMConstants.vmsDir.appendingPathComponent("\(name).vm")

        guard !FileManager.default.fileExists(atPath: vmDir.path) else {
            throw NSError(
                domain: "HoustonVM", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "VM already exists"])
        }

        try FileManager.default.createDirectory(at: vmDir, withIntermediateDirectories: true)
        let dataDir = vmDir.appendingPathComponent("Data")
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)

        let effectiveRamMb = ramMb ?? 4096
        let effectiveDiskGb = diskGb ?? (guestType == "macos" ? 32 : 20)

        if guestType == "macos" {
            let config = VMConfig(
                id: id, name: name, ramMb: effectiveRamMb, diskGb: effectiveDiskGb,
                guestType: "macos", isoPath: nil, ipswPath: ipswPath, macAddress: nil)
            let configData = try JSONEncoder().encode(config)
            try configData.write(to: vmDir.appendingPathComponent("config.json"))
            Task { await createMacOSVMAndInstall(id: id, vmDir: vmDir, ipswPath: ipswPath) }
            return [
                "id": id, "name": name, "path": vmDir.path, "status": "installing",
                "ramMb": effectiveRamMb, "diskGb": effectiveDiskGb, "guestType": "macos",
            ]
        }

        let diskPath = dataDir.appendingPathComponent("disk.raw")
        FileManager.default.createFile(atPath: diskPath.path, contents: nil)
        let sizeBytes = UInt64(effectiveDiskGb) * 1024 * 1024 * 1024
        let handle = try FileHandle(forWritingTo: diskPath)
        try handle.truncate(atOffset: sizeBytes)
        try handle.close()

        let efiPath = dataDir.appendingPathComponent("efi_vars.fd")
        _ = try VZEFIVariableStore(creatingVariableStoreAt: efiPath, options: .allowOverwrite)

        let config = VMConfig(
            id: id, name: name, ramMb: effectiveRamMb, diskGb: effectiveDiskGb,
            guestType: "linux", isoPath: isoPath, ipswPath: nil, macAddress: nil)
        let configData = try JSONEncoder().encode(config)
        try configData.write(to: vmDir.appendingPathComponent("config.json"))

        if let vm = listVMs().first(where: { ($0["id"] as? String) == id }) {
            return vm
        }
        return [
            "id": id, "name": name, "path": vmDir.path, "status": "stopped",
            "ramMb": effectiveRamMb, "diskGb": effectiveDiskGb, "guestType": "linux",
        ]
    }

    func createLinuxVM(at vmDir: URL) throws -> (VZVirtualMachine, FileHandle?) {
        let dataDir = vmDir.appendingPathComponent("Data")
        let diskPath = dataDir.appendingPathComponent("disk.raw")
        let efiPath = dataDir.appendingPathComponent("efi_vars.fd")

        print("[HoustonVM] createLinuxVM at \(vmDir.path)")
        print(
            "[HoustonVM]   disk: \(diskPath.path) exists=\(FileManager.default.fileExists(atPath: diskPath.path))"
        )
        print(
            "[HoustonVM]   efi: \(efiPath.path) exists=\(FileManager.default.fileExists(atPath: efiPath.path))"
        )

        guard FileManager.default.fileExists(atPath: diskPath.path) else {
            throw NSError(
                domain: "HoustonVM", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Disk not found"])
        }

        let config = VZVirtualMachineConfiguration()
        config.platform = VZGenericPlatformConfiguration()

        let bootLoader = VZEFIBootLoader()
        if FileManager.default.fileExists(atPath: efiPath.path) {
            bootLoader.variableStore = VZEFIVariableStore(url: efiPath)
            print("[HoustonVM]   using EFI variable store")
        } else {
            print("[HoustonVM]   no EFI store, using default boot")
        }
        config.bootLoader = bootLoader

        let configPath = vmDir.appendingPathComponent("config.json")
        var vmRamMb = HoustonVMConstants.vmRamMb
        if let data = try? Data(contentsOf: configPath),
            let vmConfig = try? JSONDecoder().decode(VMConfig.self, from: data)
        {
            vmRamMb = UInt64(max(4096, min(65536, vmConfig.ramMb)))
        }
        config.cpuCount = HoustonVMConstants.vmCpus
        config.memorySize = vmRamMb * 1024 * 1024
        print("[HoustonVM]   cpus=\(HoustonVMConstants.vmCpus) ram=\(vmRamMb)MB")

        var storageDevices: [VZStorageDeviceConfiguration] = []
        var vmIsoPath: URL?
        if let data = try? Data(contentsOf: configPath),
            let vmConfig = try? JSONDecoder().decode(VMConfig.self, from: data),
            let path = vmConfig.isoPath, !path.isEmpty
        {
            vmIsoPath = URL(fileURLWithPath: path)
        }
        if vmIsoPath == nil {
            vmIsoPath = HoustonVMConstants.debianIsoPath
        }
        let isoPath = vmIsoPath!
        if FileManager.default.fileExists(atPath: isoPath.path) {
            let isoAttachment = try VZDiskImageStorageDeviceAttachment(url: isoPath, readOnly: true)
            let isoBlock = VZVirtioBlockDeviceConfiguration(attachment: isoAttachment)
            storageDevices.append(isoBlock)
            print("[HoustonVM]   ISO attached: \(isoPath.path) (boot first)")
        } else {
            print(
                "[HoustonVM]   ISO not found at \(isoPath.path), download Debian arm64 netinst to that path"
            )
        }

        // Use .cached to prevent filesystem corruption on Linux VMs (UTM #5919, Lima #2026)
        let diskAttachment = try VZDiskImageStorageDeviceAttachment(
            url: diskPath, readOnly: false, cachingMode: .cached, synchronizationMode: .full)
        let blockDevice = VZVirtioBlockDeviceConfiguration(attachment: diskAttachment)
        storageDevices.append(blockDevice)
        config.storageDevices = storageDevices
        print("[HoustonVM]   disk attached (cached)")

        let networkAttachment = VZNATNetworkDeviceAttachment()
        let networkDevice = VZVirtioNetworkDeviceConfiguration()
        networkDevice.attachment = networkAttachment
        networkDevice.macAddress = try getOrCreateMacAddress(vmDir: vmDir)
        config.networkDevices = [networkDevice]
        print("[HoustonVM]   network: NAT (VZNATNetworkDeviceAttachment)")

        let graphicsDevice = VZVirtioGraphicsDeviceConfiguration()
        graphicsDevice.scanouts = [
            VZVirtioGraphicsScanoutConfiguration(widthInPixels: Int(virtualDisplayWidth), heightInPixels: Int(virtualDisplayHeight))
        ]
        config.graphicsDevices = [graphicsDevice]
        print("[HoustonVM]   graphics: \(Int(virtualDisplayWidth))x\(Int(virtualDisplayHeight))")

        config.keyboards = [VZUSBKeyboardConfiguration()]
        config.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]

        let serialLogPath = vmDir.appendingPathComponent("serial.log")
        FileManager.default.createFile(atPath: serialLogPath.path, contents: nil)
        var serialHandle: FileHandle?
        if let serialFile = try? FileHandle(forWritingTo: serialLogPath) {
            try? serialFile.truncate(atOffset: 0)
            serialHandle = serialFile
            let serialAttachment = VZFileHandleSerialPortAttachment(
                fileHandleForReading: nil, fileHandleForWriting: serialFile)
            let serialConfig = VZVirtioConsoleDeviceSerialPortConfiguration()
            serialConfig.attachment = serialAttachment
            config.serialPorts = [serialConfig]
            print("[HoustonVM]   serial port -> \(serialLogPath.path)")
        }

        try config.validate()
        print("[HoustonVM]   config validated")

        return (VZVirtualMachine(configuration: config), serialHandle)
    }

    /// Check if an IPSW file is supported on this host (mostFeaturefulSupportedConfiguration != nil).
    func checkIpswSupported(path: String) async -> Bool {
        guard let resolved = resolveIpswPath(path) else { return false }
        let url = URL(fileURLWithPath: resolved)
        do {
            let img = try await withCheckedThrowingContinuation {
                (cont: CheckedContinuation<VZMacOSRestoreImage, Error>) in
                VZMacOSRestoreImage.load(from: url) { result in
                    switch result {
                    case .success(let img): cont.resume(returning: img)
                    case .failure(let err): cont.resume(throwing: err)
                    }
                }
            }
            return img.mostFeaturefulSupportedConfiguration != nil
        } catch {
            return false
        }
    }

    /// Resolves user-provided IPSW path: expands ~, strips file://, standardizes.
    private func resolveIpswPath(_ path: String?) -> String? {
        guard let p = path, !p.isEmpty else { return nil }
        var resolved = p.trimmingCharacters(in: .whitespaces)
        if resolved.hasPrefix("file://") {
            if let url = URL(string: resolved) {
                resolved = url.path
            }
        }
        resolved = (resolved as NSString).expandingTildeInPath
        resolved = (resolved as NSString).standardizingPath
        guard FileManager.default.fileExists(atPath: resolved) else { return nil }
        return resolved
    }

    func createMacOSVMAndInstall(id: String, vmDir: URL, ipswPath: String? = nil) async {
        let dataDir = vmDir.appendingPathComponent("Data")
        let diskPath = dataDir.appendingPathComponent("disk.img")
        let auxPath = dataDir.appendingPathComponent("auxiliary_storage")
        let configPath = vmDir.appendingPathComponent("config.json")

        print("[HoustonVM] createMacOSVMAndInstall \(id) ipswPath=\(ipswPath ?? "nil")")
        fflush(stdout)

        do {
            macOSCreatingProgress[id] = ("checking for restore image", 0)
            try FileManager.default.createDirectory(
                at: HoustonVMConstants.isosDir, withIntermediateDirectories: true)

            var restoreImage: VZMacOSRestoreImage?
            var ipswURL: URL?

            if let path = resolveIpswPath(ipswPath) {
                let url = URL(fileURLWithPath: path)
                do {
                    let img = try await withCheckedThrowingContinuation {
                        (cont: CheckedContinuation<VZMacOSRestoreImage, Error>) in
                        VZMacOSRestoreImage.load(from: url) { result in
                            switch result {
                            case .success(let img): cont.resume(returning: img)
                            case .failure(let err): cont.resume(throwing: err)
                            }
                        }
                    }
                    if img.mostFeaturefulSupportedConfiguration != nil {
                        restoreImage = img
                        ipswURL = url
                        print("[HoustonVM]   using selected ipsw: \(path)")
                    } else {
                        print(
                            "[HoustonVM]   selected ipsw has no supported config for this host (try a different IPSW or let it auto-download): \(path)"
                        )
                    }
                } catch {
                    print(
                        "[HoustonVM]   failed to load selected ipsw \(path): \(error.localizedDescription)"
                    )
                }
            } else if let p = ipswPath, !p.isEmpty {
                print("[HoustonVM]   ipsw path not found or invalid: \(p)")
            }

            if restoreImage == nil,
                let entries = try? FileManager.default.contentsOfDirectory(
                    at: HoustonVMConstants.isosDir, includingPropertiesForKeys: nil)
            {
                let ipswFiles = entries.filter { $0.pathExtension.lowercased() == "ipsw" }
                for file in ipswFiles {
                    let loaded = try? await withCheckedThrowingContinuation {
                        (cont: CheckedContinuation<VZMacOSRestoreImage, Error>) in
                        VZMacOSRestoreImage.load(from: file) { result in
                            switch result {
                            case .success(let img): cont.resume(returning: img)
                            case .failure(let err): cont.resume(throwing: err)
                            }
                        }
                    }
                    if let img = loaded, img.mostFeaturefulSupportedConfiguration != nil {
                        restoreImage = img
                        ipswURL = file
                        print(
                            "[HoustonVM]   using existing ipsw in ISOs: \(file.lastPathComponent)")
                        break
                    }
                }
            }

            if restoreImage == nil {
                macOSCreatingProgress[id] = ("fetching restore image", 0)
                let fetched = try await withCheckedThrowingContinuation { cont in
                    VZMacOSRestoreImage.fetchLatestSupported { result in
                        switch result {
                        case .success(let img): cont.resume(returning: img)
                        case .failure(let err): cont.resume(throwing: err)
                        }
                    }
                }
                restoreImage = fetched
                let fetchedURL = fetched.url

                if fetchedURL.isFileURL {
                    print("[HoustonVM]   using local ipsw: \(fetchedURL.path)")
                    ipswURL = fetchedURL
                } else {
                    let ipswFilename =
                        fetchedURL.lastPathComponent.components(separatedBy: "?").first
                        ?? fetchedURL.lastPathComponent
                    let localIpswPath = HoustonVMConstants.isosDir.appendingPathComponent(
                        ipswFilename)
                    if FileManager.default.fileExists(atPath: localIpswPath.path) {
                        print(
                            "[HoustonVM]   using cached ipsw in ISOs: \(localIpswPath.lastPathComponent)"
                        )
                        ipswURL = localIpswPath
                    } else {
                        print("[HoustonVM]   downloading ipsw to \(localIpswPath.path)...")
                        macOSCreatingProgress[id] = ("downloading ipsw", 0)
                        _ = try await downloadWithProgress(
                            from: fetchedURL, vmId: id, to: localIpswPath)
                        ipswURL = localIpswPath
                        print("[HoustonVM]   download complete")
                    }
                }
            }

            guard let img = restoreImage, let ipswURLToUse = ipswURL else {
                print("[HoustonVM]   no restore image available")
                macOSCreatingProgress.removeValue(forKey: id)
                return
            }

            macOSCreatingProgress.removeValue(forKey: id)

            guard let configToUse = img.mostFeaturefulSupportedConfiguration else {
                print("[HoustonVM]   no supported config for this host")
                return
            }

            let machineIdentifier = VZMacMachineIdentifier()
            let hardwareModel = configToUse.hardwareModel

            var diskGb: UInt64 = HoustonVMConstants.macDiskSizeGb
            if let data = try? Data(contentsOf: configPath),
                let c = try? JSONDecoder().decode(VMConfig.self, from: data)
            {
                diskGb = UInt64(max(8, min(512, c.diskGb)))
            }
            let diskSizeBytes = diskGb * 1024 * 1024 * 1024
            FileManager.default.createFile(atPath: diskPath.path, contents: nil)
            let handle = try FileHandle(forWritingTo: diskPath)
            try handle.truncate(atOffset: diskSizeBytes)
            try handle.close()

            let auxiliaryStorage = try VZMacAuxiliaryStorage(
                creatingStorageAt: auxPath, hardwareModel: hardwareModel, options: .allowOverwrite)

            let config = VZVirtualMachineConfiguration()
            config.bootLoader = VZMacOSBootLoader()
            config.platform = {
                let p = VZMacPlatformConfiguration()
                p.hardwareModel = hardwareModel
                p.machineIdentifier = machineIdentifier
                p.auxiliaryStorage = auxiliaryStorage
                return p
            }()
            config.cpuCount = max(2, configToUse.minimumSupportedCPUCount)
            var memBytes = max(4 * 1024 * 1024 * 1024, configToUse.minimumSupportedMemorySize)
            if let data = try? Data(contentsOf: configPath),
                let c = try? JSONDecoder().decode(VMConfig.self, from: data)
            {
                let userRamBytes = UInt64(max(4096, min(65536, c.ramMb))) * 1024 * 1024
                memBytes = max(memBytes, userRamBytes)
            }
            config.memorySize = memBytes

            let diskAttachment = try VZDiskImageStorageDeviceAttachment(
                url: diskPath, readOnly: false)
            config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: diskAttachment)]

            let networkAttachment = VZNATNetworkDeviceAttachment()
            let networkDevice = VZVirtioNetworkDeviceConfiguration()
            networkDevice.attachment = networkAttachment
            networkDevice.macAddress = try getOrCreateMacAddress(vmDir: vmDir)
            config.networkDevices = [networkDevice]

            let graphics = VZMacGraphicsDeviceConfiguration()
            graphics.displays = [
                VZMacGraphicsDisplayConfiguration(
                    widthInPixels: Int(virtualDisplayWidth), heightInPixels: Int(virtualDisplayHeight), pixelsPerInch: virtualDisplayPixelsPerInch)
            ]
            config.graphicsDevices = [graphics]

            config.keyboards = [VZUSBKeyboardConfiguration()]
            config.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
            config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

            try config.validate()

            let vm = VZVirtualMachine(configuration: config)
            let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: ipswURLToUse)

            let view = VZVirtualMachineView()
            view.virtualMachine = vm
            view.capturesSystemKeys = true

            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: virtualDisplayWidth, height: virtualDisplayHeight),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.title = "Houston-\(id) — macOS Installer"
            window.contentView?.addSubview(view)
            view.frame = window.contentView?.bounds ?? .zero
            view.autoresizingMask = [.width, .height]
            window.center()
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)

            installingMacOS[id] = (installer.progress, window)

            try hardwareModel.dataRepresentation.write(
                to: dataDir.appendingPathComponent("HardwareModel"))
            try machineIdentifier.dataRepresentation.write(
                to: dataDir.appendingPathComponent("MachineIdentifier"))

            var vmConfig = VMConfig(
                id: id, name: "Houston-\(id)", ramMb: 4096, diskGb: 128, guestType: "macos",
                isoPath: nil, ipswPath: ipswURLToUse.path, macAddress: nil)
            if let data = try? Data(contentsOf: configPath),
                let c = try? JSONDecoder().decode(VMConfig.self, from: data)
            {
                vmConfig = c
            }
            vmConfig.ipswPath = ipswURLToUse.path
            vmConfig.guestType = "macos"
            try? JSONEncoder().encode(vmConfig).write(to: configPath)

            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                installer.install { result in
                    DispatchQueue.main.async {
                        self.installingMacOS.removeValue(forKey: id)
                        switch result {
                        case .success:
                            print("[HoustonVM]   macOS installation complete")
                        case .failure(let err):
                            print("[HoustonVM]   macOS installation failed: \(err)")
                        }
                        cont.resume()
                    }
                }
            }

            window.orderOut(nil)
        } catch {
            print("[HoustonVM] createMacOSVMAndInstall failed: \(error)")
            installingMacOS.removeValue(forKey: id)
            macOSCreatingProgress.removeValue(forKey: id)
        }
    }

    private func downloadWithProgress(from url: URL, vmId: String, to destination: URL) async throws
        -> URL
    {
        final class DownloadDelegate: NSObject, URLSessionDownloadDelegate {
            var continuation: CheckedContinuation<URL, Error>?
            let destination: URL
            init(destination: URL) { self.destination = destination }
            func urlSession(
                _ session: URLSession, downloadTask: URLSessionDownloadTask,
                didFinishDownloadingTo location: URL
            ) {
                do {
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.moveItem(at: location, to: destination)
                    continuation?.resume(returning: destination)
                } catch {
                    continuation?.resume(throwing: error)
                }
                continuation = nil
            }
            func urlSession(
                _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
            ) {
                if let err = error, continuation != nil {
                    continuation?.resume(throwing: err)
                    continuation = nil
                }
            }
        }
        let delegate = DownloadDelegate(destination: destination)
        let config = URLSessionConfiguration.default
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        let task = session.downloadTask(with: url)
        let progress = task.progress
        let obs = progress.observe(\.fractionCompleted, options: [.initial, .new]) {
            [weak self] prog, _ in
            Task { @MainActor in
                self?.macOSCreatingProgress[vmId] = ("downloading ipsw", prog.fractionCompleted)
            }
        }
        defer { obs.invalidate() }
        return try await withCheckedThrowingContinuation {
            (cont: CheckedContinuation<URL, Error>) in
            delegate.continuation = cont
            task.resume()
        }
    }

    /// Ensures the default Debian ISO exists at debianIsoPath. Downloads from debianIsoUrl if missing.
    private func ensureDebianIsoExists() async throws {
        let dest = HoustonVMConstants.debianIsoPath
        if FileManager.default.fileExists(atPath: dest.path) {
            return
        }
        try FileManager.default.createDirectory(
            at: HoustonVMConstants.isosDir, withIntermediateDirectories: true)
        print("[HoustonVM]   downloading Debian ISO to \(dest.path)...")
        _ = try await downloadWithProgress(
            from: HoustonVMConstants.debianIsoUrl, vmId: "_debian", to: dest)
        print("[HoustonVM]   Debian ISO downloaded")
    }

    func createMacOSVM(at vmDir: URL) throws -> (VZVirtualMachine, FileHandle?) {
        let dataDir = vmDir.appendingPathComponent("Data")
        let diskPath = dataDir.appendingPathComponent("disk.img")
        let auxPath = dataDir.appendingPathComponent("auxiliary_storage")
        let hwPath = dataDir.appendingPathComponent("HardwareModel")
        let midPath = dataDir.appendingPathComponent("MachineIdentifier")

        guard FileManager.default.fileExists(atPath: diskPath.path),
            FileManager.default.fileExists(atPath: auxPath.path)
        else {
            throw NSError(
                domain: "HoustonVM", code: 2,
                userInfo: [
                    NSLocalizedDescriptionKey: "macOS VM not installed - run installation first"
                ])
        }

        guard let hwData = try? Data(contentsOf: hwPath),
            let midData = try? Data(contentsOf: midPath),
            let hardwareModel = VZMacHardwareModel(dataRepresentation: hwData),
            let machineIdentifier = VZMacMachineIdentifier(dataRepresentation: midData)
        else {
            throw NSError(
                domain: "HoustonVM", code: 2,
                userInfo: [
                    NSLocalizedDescriptionKey: "macOS VM config missing - reinstall required"
                ])
        }

        let config = VZVirtualMachineConfiguration()
        config.bootLoader = VZMacOSBootLoader()
        config.platform = {
            let p = VZMacPlatformConfiguration()
            p.hardwareModel = hardwareModel
            p.machineIdentifier = machineIdentifier
            p.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: auxPath)
            return p
        }()
        var vmRamMb = HoustonVMConstants.vmRamMb
        let configPath = vmDir.appendingPathComponent("config.json")
        if let data = try? Data(contentsOf: configPath),
            let vmConfig = try? JSONDecoder().decode(VMConfig.self, from: data)
        {
            vmRamMb = UInt64(max(4096, min(65536, vmConfig.ramMb)))
        }
        config.cpuCount = HoustonVMConstants.vmCpus
        config.memorySize = vmRamMb * 1024 * 1024

        let diskAttachment = try VZDiskImageStorageDeviceAttachment(url: diskPath, readOnly: false)
        config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: diskAttachment)]

        let networkAttachment = VZNATNetworkDeviceAttachment()
        let networkDevice = VZVirtioNetworkDeviceConfiguration()
        networkDevice.attachment = networkAttachment
        networkDevice.macAddress = try getOrCreateMacAddress(vmDir: vmDir)
        config.networkDevices = [networkDevice]

        let graphics = VZMacGraphicsDeviceConfiguration()
        graphics.displays = [
            VZMacGraphicsDisplayConfiguration(
                widthInPixels: Int(virtualDisplayWidth), heightInPixels: Int(virtualDisplayHeight), pixelsPerInch: virtualDisplayPixelsPerInch)
        ]
        config.graphicsDevices = [graphics]

        config.keyboards = [VZUSBKeyboardConfiguration()]
        config.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

        let serialLogPath = vmDir.appendingPathComponent("serial.log")
        FileManager.default.createFile(atPath: serialLogPath.path, contents: nil)
        var serialHandle: FileHandle?
        if let serialFile = try? FileHandle(forWritingTo: serialLogPath) {
            try? serialFile.truncate(atOffset: 0)
            serialHandle = serialFile
            let serialAttachment = VZFileHandleSerialPortAttachment(
                fileHandleForReading: nil, fileHandleForWriting: serialFile)
            let serialConfig = VZVirtioConsoleDeviceSerialPortConfiguration()
            serialConfig.attachment = serialAttachment
            config.serialPorts = [serialConfig]
            print("[HoustonVM]   serial port -> \(serialLogPath.path)")
        }

        try config.validate()
        return (VZVirtualMachine(configuration: config), serialHandle)
    }

    func startVM(id: String) async throws {
        print("[HoustonVM] startVM(\(id))")
        if runningVM?.id == id {
            print("[HoustonVM]   already running, skipping")
            return
        }

        let vmDir = HoustonVMConstants.vmsDir.appendingPathComponent("Houston-\(id).vm")
        guard FileManager.default.fileExists(atPath: vmDir.path) else {
            throw NSError(
                domain: "HoustonVM", code: 3, userInfo: [NSLocalizedDescriptionKey: "VM not found"])
        }

        let configPath = vmDir.appendingPathComponent("config.json")
        var vmConfig: VMConfig?
        if let data = try? Data(contentsOf: configPath),
            let c = try? JSONDecoder().decode(VMConfig.self, from: data)
        {
            vmConfig = c
        }
        let guestType = vmConfig?.guestType ?? "linux"

        print("[HoustonVM]   creating VM config (\(guestType))...")
        let vm: VZVirtualMachine
        let serialHandle: FileHandle?
        if guestType == "macos" {
            (vm, serialHandle) = try createMacOSVM(at: vmDir)
        } else {
            let needsDefaultIso = (vmConfig?.isoPath ?? "").isEmpty
            if needsDefaultIso {
                try await ensureDebianIsoExists()
            }
            (vm, serialHandle) = try createLinuxVM(at: vmDir)
        }
        let view = VZVirtualMachineView()
        view.virtualMachine = vm
        view.capturesSystemKeys = true

        let automator = VZAutomator(view: view)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: virtualDisplayWidth, height: virtualDisplayHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Houston-\(id) — VM Console"
        window.contentView?.addSubview(view)
        view.frame = window.contentView?.bounds ?? .zero
        view.autoresizingMask = [.width, .height]
        window.center()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)

        let windowDelegate = VMWindowDelegate(vmId: id)
        window.delegate = windowDelegate

        let delegate = VMDelegate()
        vm.delegate = delegate

        print("[HoustonVM]   starting VM...")
        try await vm.start()
        print("[HoustonVM]   VM started, state=\(vm.state.rawValue)")

        reconfigureDisplayToFullHD(vm)

        runningVM = (id, vm, view, automator, delegate, windowDelegate, serialHandle)
        print(
            "[HoustonVM] startVM done. Note: empty disk = black screen until you install an OS (attach ISO). Serial log: \(vmDir.path)/serial.log"
        )
    }

    func showConsole(id: String) {
        guard runningVM?.id == id, let view = runningVM?.view else { return }
        if let win = view.window {
            win.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: virtualDisplayWidth, height: virtualDisplayHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Houston-\(id) — VM Console"
        window.contentView?.addSubview(view)
        view.frame = window.contentView?.bounds ?? .zero
        view.autoresizingMask = [.width, .height]
        window.center()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if let windowDelegate = runningVM?.windowDelegate {
            window.delegate = windowDelegate
        }
    }

    /// Stop VM with 30s timeout. If guest is frozen, vm.stop() can hang indefinitely; this prevents blocking.
    private func stopVMWithTimeout(_ vm: VZVirtualMachine) async throws {
        let stopTimeoutNs: UInt64 = 30_000_000_000
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await vm.stop() }
            group.addTask {
                try await Task.sleep(nanoseconds: stopTimeoutNs)
                throw NSError(
                    domain: "HoustonVM", code: 5,
                    userInfo: [NSLocalizedDescriptionKey: "VM stop timed out after 30s (guest may be frozen)"]
                )
            }
            _ = try await group.next()
            group.cancelAll()
        }
    }

    func stopVM(id: String, force: Bool = false) async throws {
        guard runningVM?.id == id else { return }
        guard let vm = runningVM?.vm else { return }
        let window = runningVM?.view.window
        let automator = runningVM?.automator

        let guestType = guestType(forVMId: id)

        if !force && guestType == "macos" {
            // macOS guest does not respond to requestStop (PL061 GPIO); it ignores the signal.
            // Send Control+Option+Command+Power to trigger graceful shutdown from within the guest.
            if let automator = automator {
                print(
                    "[HoustonVM] Sending shutdown shortcut (Control+Option+Command+Power) to macOS guest"
                )
                window?.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                do {
                    let shutdownKey = VZAutomator.Key.keyboardPower.control.alt.modify(.command)
                    try await automator.press(key: shutdownKey)
                    try await Task.sleep(nanoseconds: 3_000_000_000)  // 3 seconds for shutdown to start
                } catch {
                    print("[HoustonVM] Shutdown shortcut failed: \(error), will try requestStop")
                }
            }
        }

        if !force && guestType == "linux", let automator = automator {
            // Linux: try ACPI power button before requestStop. Triggers graceful shutdown via acpid/systemd-logind.
            // Note: Ctrl+Alt+Del triggers reboot, not shutdown — do not use it here.
            print("[HoustonVM] Sending ACPI power button to Linux guest for graceful shutdown")
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            do {
                try await automator.press(key: .keyboardPower)
                try await Task.sleep(nanoseconds: 2_000_000_000)  // 2 seconds
            } catch {
                print("[HoustonVM] Power button failed: \(error), will try requestStop")
            }
        }

        if !force && vm.canRequestStop {
            do {
                try vm.requestStop()
                let timeoutNs: UInt64 = guestType == "linux" ? 60_000_000_000 : 30_000_000_000
                let interval: UInt64 = 500_000_000  // 0.5 seconds
                var elapsed: UInt64 = 0
                while elapsed < timeoutNs, runningVM?.id == id {
                    try await Task.sleep(nanoseconds: interval)
                    elapsed += interval
                }
                if runningVM?.id == id {
                    print("[HoustonVM] Graceful shutdown timeout (\(timeoutNs / 1_000_000_000)s), forcing stop")
                    do { try await stopVMWithTimeout(vm) } catch { print("[HoustonVM] \(error.localizedDescription)") }
                    runningVM = nil
                }
            } catch {
                print("[HoustonVM] requestStop failed: \(error), forcing stop")
                do { try await stopVMWithTimeout(vm) } catch { print("[HoustonVM] \(error.localizedDescription)") }
                runningVM = nil
            }
        } else {
            do { try await stopVMWithTimeout(vm) } catch { print("[HoustonVM] \(error.localizedDescription)") }
            runningVM = nil
        }

        // Hide window (orderOut) instead of close - closing triggers segfault in Virtualization teardown
        window?.orderOut(nil as Any?)
    }

    func deleteVM(id: String) async throws {
        if runningVM?.id == id {
            try await stopVM(id: id)
        }

        let vmDir = HoustonVMConstants.vmsDir.appendingPathComponent("Houston-\(id).vm")
        try FileManager.default.removeItem(at: vmDir)
    }

    func screenshot(id: String) async throws -> Data? {
        guard runningVM?.id == id, let view = runningVM?.view else { return nil }
        if view.window == nil {
            showConsole(id: id)
            try? await Task.sleep(nanoseconds: 450_000_000)
        }
        return captureFromIOSurface(view)
    }

    func typeText(id: String, text: String) async throws {
        guard runningVM?.id == id, let automator = runningVM?.automator else { return }
        try await automator.type(text)
    }

    func pressKey(id: String, key: String) async throws {
        guard runningVM?.id == id, let automator = runningVM?.automator else { return }
        let k = keyFromName(key)
        try await automator.press(key: k)
    }

    /// Reconfigure all graphics displays to virtual resolution. Fixes existing VMs created with other resolutions.
    private func reconfigureDisplayToFullHD(_ vm: VZVirtualMachine) {
        guard #available(macOS 14.0, *) else { return }
        let targetSize = CGSize(width: virtualDisplayWidth, height: virtualDisplayHeight)
        for device in vm.graphicsDevices {
            for display in device.displays {
                let current = display.sizeInPixels
                guard current.width != targetSize.width || current.height != targetSize.height
                else {
                    continue
                }
                do {
                    try display.reconfigure(sizeInPixels: targetSize)
                    print(
                        "[HoustonVM]   display reconfigured \(Int(current.width))×\(Int(current.height)) → \(Int(virtualDisplayWidth))×\(Int(virtualDisplayHeight))"
                    )
                } catch {
                    print("[HoustonVM]   display reconfigure failed: \(error.localizedDescription)")
                }
            }
        }
    }

    /// Convert (x,y) from virtual display space (top-down, origin top-left) to view coordinates.
    /// Uses displaySubview's frame when available so letterboxing/pillarboxing is handled correctly.
    /// NSView is bottom-up. Display y=0 (top) maps to content rect top (maxY).
    private func displayToView(view: NSView, x: Double, y: Double) -> NSPoint {
        let dw = virtualDisplayWidth
        let dh = virtualDisplayHeight
        let contentRect: CGRect
        if let sub = view.subviews.first, sub.layer?.contents is IOSurface {
            contentRect = sub.frame
        } else {
            contentRect = view.bounds
        }
        guard contentRect.width > 0, contentRect.height > 0 else {
            return NSPoint(x: x, y: view.bounds.height - y)
        }
        let sx = contentRect.width / dw
        let sy = contentRect.height / dh
        let xView = contentRect.minX + x * sx
        let yView = contentRect.maxY - y * sy
        return NSPoint(x: xView, y: yView)
    }

    func moveMouse(id: String, x: Double, y: Double) async throws {
        guard runningVM?.id == id, let view = runningVM?.view else { return }
        if view.window == nil { showConsole(id: id) }
        guard let win = view.window else { return }
        let pt = displayToView(view: view, x: x, y: y)
        let locInWindow = view.convert(pt, to: nil)
        if let ev = NSEvent.mouseEvent(
            with: .mouseMoved,
            location: locInWindow,
            modifierFlags: [],
            timestamp: NSDate.now.timeIntervalSince1970,
            windowNumber: win.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 0,
            pressure: 0
        ) {
            view.mouseMoved(with: ev)
        }
    }

    /// Move mouse while left button is held (for drag operations). Sends leftMouseDragged so the view receives mouseDragged(with:).
    func moveMouseDragging(id: String, x: Double, y: Double) async throws {
        guard runningVM?.id == id, let view = runningVM?.view else { return }
        if view.window == nil { showConsole(id: id) }
        guard let win = view.window else { return }
        let pt = displayToView(view: view, x: x, y: y)
        let locInWindow = view.convert(pt, to: nil)
        if let ev = NSEvent.mouseEvent(
            with: .leftMouseDragged,
            location: locInWindow,
            modifierFlags: [],
            timestamp: NSDate.now.timeIntervalSince1970,
            windowNumber: win.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 0,
            pressure: 1.0
        ) {
            view.mouseDragged(with: ev)
        }
    }

    func click(id: String, x: Double? = nil, y: Double? = nil, doubleClick: Bool = false)
        async throws
    {
        guard runningVM?.id == id, let view = runningVM?.view else { return }
        if view.window == nil { showConsole(id: id) }
        guard let win = view.window else { return }
        let pt: NSPoint
        if let x = x, let y = y {
            pt = displayToView(view: view, x: x, y: y)
        } else {
            pt = NSPoint(x: view.bounds.midX, y: view.bounds.midY)
        }
        let locInWindow = view.convert(pt, to: nil)
        let winNum = win.windowNumber
        let clicks: [(Int, Int)] = doubleClick ? [(1, 1), (2, 2)] : [(1, 1)]
        for (downCount, upCount) in clicks {
            if doubleClick && downCount == 2 {
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            let ts = NSDate.now.timeIntervalSince1970
            if let down = NSEvent.mouseEvent(
                with: .leftMouseDown,
                location: locInWindow,
                modifierFlags: [],
                timestamp: ts,
                windowNumber: winNum,
                context: nil,
                eventNumber: 0,
                clickCount: downCount,
                pressure: 1.0
            ),
                let up = NSEvent.mouseEvent(
                    with: .leftMouseUp,
                    location: locInWindow,
                    modifierFlags: [],
                    timestamp: ts,
                    windowNumber: winNum,
                    context: nil,
                    eventNumber: 0,
                    clickCount: upCount,
                    pressure: 0
                )
            {
                view.mouseDown(with: down)
                view.mouseUp(with: up)
            }
        }
    }

    func mouseDown(id: String, x: Double, y: Double) async throws {
        guard runningVM?.id == id, let view = runningVM?.view else { return }
        if view.window == nil { showConsole(id: id) }
        guard let win = view.window else { return }
        try await moveMouse(id: id, x: x, y: y)
        let pt = displayToView(view: view, x: x, y: y)
        let locInWindow = view.convert(pt, to: nil)
        let ts = NSDate.now.timeIntervalSince1970
        if let ev = NSEvent.mouseEvent(
            with: .leftMouseDown,
            location: locInWindow,
            modifierFlags: [],
            timestamp: ts,
            windowNumber: win.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1.0
        ) {
            view.mouseDown(with: ev)
        }
    }

    func mouseUp(id: String, x: Double, y: Double) async throws {
        guard runningVM?.id == id, let view = runningVM?.view else { return }
        if view.window == nil { showConsole(id: id) }
        guard let win = view.window else { return }
        let pt = displayToView(view: view, x: x, y: y)
        let locInWindow = view.convert(pt, to: nil)
        let ts = NSDate.now.timeIntervalSince1970
        if let ev = NSEvent.mouseEvent(
            with: .leftMouseUp,
            location: locInWindow,
            modifierFlags: [],
            timestamp: ts,
            windowNumber: win.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 0
        ) {
            view.mouseUp(with: ev)
        }
    }

    /// Scroll at coordinates. deltaY: positive = up, negative = down. deltaX: positive = left, negative = right.
    /// Uses line units (wheel clicks) for predictable behavior in VMs; pixel units are unreliable.
    func scroll(
        id: String, x: Double? = nil, y: Double? = nil, deltaX: Double = 0, deltaY: Double = 0
    ) async throws {
        guard runningVM?.id == id, let view = runningVM?.view else { return }
        if view.window == nil { showConsole(id: id) }
        guard let win = view.window else { return }
        if let x = x, let y = y {
            try await moveMouse(id: id, x: x, y: y)
        }
        let pt: NSPoint
        if let x = x, let y = y {
            pt = displayToView(view: view, x: x, y: y)
        } else {
            pt = NSPoint(x: view.bounds.midX, y: view.bounds.midY)
        }
        let locInWindow = view.convert(pt, to: nil)
        let screenLoc = win.convertPoint(toScreen: locInWindow)
        let linesY = Int32(deltaY)
        let linesX = Int32(deltaX)
        let wheelCount: UInt32 = (linesX != 0 || linesY != 0) ? 2 : 1
        guard
            let cgEvent = CGEvent(
                scrollWheelEvent2Source: nil,
                units: .line,
                wheelCount: wheelCount,
                wheel1: linesY,
                wheel2: linesX,
                wheel3: 0
            )
        else { return }
        cgEvent.location = CGPoint(x: screenLoc.x, y: screenLoc.y)
        if let nsEvent = NSEvent(cgEvent: cgEvent) {
            view.scrollWheel(with: nsEvent)
        }
    }

    /// Probe which capture methods succeed; returns method name -> size + center pixel from output
    func screenshotProbe(id: String) async -> [String: Any]? {
        guard runningVM?.id == id, let view = runningVM?.view else { return nil }
        var results: [String: Any] = [:]
        func addResult(_ name: String, _ data: Data?, _ cgImage: CGImage?) {
            guard let data = data else { return }
            var info: [String: Any] = ["size": data.count]
            if let img = cgImage {
                info["width"] = img.width
                info["height"] = img.height
                if let centerPixel = sampleCenterPixel(img) {
                    info["centerPixel"] = centerPixel
                }
            }
            results[name] = info
        }
        if let win = view.window, win.contentView != nil {
            let windowRect = view.convert(view.bounds, to: nil)
            let screenRect = win.convertToScreen(windowRect)
            if let cgImage = CGWindowListCreateImage(
                screenRect,
                .optionIncludingWindow,
                CGWindowID(win.windowNumber),
                .bestResolution
            ) {
                let bitmap = NSBitmapImageRep(cgImage: cgImage)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    addResult("cgwindow", png, cgImage)
                }
            }
            if let (data, cg) = captureViaCIImageWithCGImage(view) {
                addResult("ciimage", data, cg)
            }
            if let (data, cg) = captureFromIOSurfaceWithCGImage(view) {
                addResult("iosurface", data, cg)
            }
            if let (data, cg) = captureViewLayerWithCGImage(view) {
                addResult("layer", data, cg)
            }
        }
        if let automator = runningVM?.automator {
            if let image = try? await automator.screenshot(), let tiff = image.tiffRepresentation,
                let bitmap = NSBitmapImageRep(data: tiff),
                let png = bitmap.representation(
                    using: .png as NSBitmapImageRep.FileType, properties: [:])
            {
                if let cg = bitmap.cgImage {
                    addResult("automator", png, cg)
                } else {
                    results["automator"] = ["size": png.count]
                }
            }
        }
        return ["methods": results]
    }

    private func sampleCenterPixel(_ cgImage: CGImage) -> [Int]? {
        let w = cgImage.width
        let h = cgImage.height
        guard w > 0, h > 0 else { return nil }
        let x = w / 2
        let y = h / 2
        var pixel: [UInt8] = [0, 0, 0, 0]
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
        guard
            let ctx = CGContext(
                data: &pixel,
                width: 1,
                height: 1,
                bitsPerComponent: 8,
                bytesPerRow: 4,
                space: colorSpace,
                bitmapInfo: bitmapInfo.rawValue
            )
        else { return nil }
        ctx.draw(
            cgImage,
            in: CGRect(x: -CGFloat(x), y: -CGFloat(y), width: CGFloat(w), height: CGFloat(h)))
        return pixel.map { Int($0) }
    }

    /// Capture screenshot using a specific method only
    func screenshotWithMethod(id: String, method: String) async throws -> Data? {
        guard runningVM?.id == id, let view = runningVM?.view else { return nil }
        switch method {
        case "cgwindow":
            guard let win = view.window, win.contentView != nil else { return nil }
            let windowRect = view.convert(view.bounds, to: nil)
            let screenRect = win.convertToScreen(windowRect)
            guard
                let cgImage = CGWindowListCreateImage(
                    screenRect, .optionIncludingWindow, CGWindowID(win.windowNumber),
                    .bestResolution)
            else { return nil }
            let bitmap = NSBitmapImageRep(cgImage: cgImage)
            return bitmap.representation(using: .png, properties: [:])
        case "ciimage":
            return captureViaCIImage(view)
        case "iosurface":
            return captureFromIOSurface(view)
        case "layer":
            return captureViewLayer(view)
        case "automator":
            guard let automator = runningVM?.automator else { return nil }
            let image = try await automator.screenshot()
            guard let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff)
            else { return nil }
            return bitmap.representation(using: .png, properties: [:])
        default:
            return nil
        }
    }

    func screenshotDebugInfo(id: String) -> [String: Any]? {
        guard runningVM?.id == id, let view = runningVM?.view else { return nil }
        guard let displaySubview = view.subviews.first,
            let surface = displaySubview.layer?.contents as? IOSurface
        else {
            return ["error": "No IOSurface in view.subviews.first"]
        }
        let pf = IOSurfaceGetPixelFormat(surface)
        let pfStr =
            String(
                bytes: [
                    UInt8((pf >> 0) & 0xFF),
                    UInt8((pf >> 8) & 0xFF),
                    UInt8((pf >> 16) & 0xFF),
                    UInt8((pf >> 24) & 0xFF),
                ], encoding: .ascii) ?? "?"
        var info: [String: Any] = [
            "width": IOSurfaceGetWidth(surface),
            "height": IOSurfaceGetHeight(surface),
            "bytesPerRow": IOSurfaceGetBytesPerRow(surface),
            "pixelFormat": pf,
            "pixelFormatStr": pfStr,
            "subviewCount": view.subviews.count,
        ]
        surface.lock(options: .readOnly, seed: nil)
        let base = IOSurfaceGetBaseAddress(surface)
        let ptr = base.assumingMemoryBound(to: UInt8.self)
        let w = IOSurfaceGetWidth(surface)
        let h = IOSurfaceGetHeight(surface)
        let bpr = IOSurfaceGetBytesPerRow(surface)
        var samples: [[Int]] = []
        for (y, x) in [(0, 0), (0, min(1, w - 1)), (min(1, h - 1), 0), (h / 2, w / 2)]
        where y < h && x < w {
            let offset = y * bpr + x * 4
            if offset + 4 <= bpr * h {
                samples.append([
                    Int(ptr[offset]), Int(ptr[offset + 1]),
                    Int(ptr[offset + 2]), Int(ptr[offset + 3]),
                ])
            }
        }
        info["pixelSamples"] = samples
        surface.unlock(options: .readOnly, seed: nil)
        return info
    }

    /// Uses CIImage(ioSurface:) + CIContext - same path as VZAutomator.screenshot, handles format correctly
    private func captureViaCIImage(_ view: NSView) -> Data? {
        captureViaCIImageWithCGImage(view)?.0
    }
    private func captureViaCIImageWithCGImage(_ view: NSView) -> (Data, CGImage)? {
        guard let displaySubview = view.subviews.first,
            let surface = displaySubview.layer?.contents as? IOSurface
        else { return nil }
        let display = CIImage(ioSurface: surface)
        let extent = display.extent
        guard extent.width > 0, extent.height > 0 else { return nil }
        let context: CIContext
        if let device = MTLCreateSystemDefaultDevice() {
            context = CIContext(mtlDevice: device)
        } else {
            context = CIContext(options: [.useSoftwareRenderer: false])
        }
        guard
            let cgImage = context.createCGImage(
                display,
                from: extent,
                format: .RGBA8,
                colorSpace: CGColorSpaceCreateDeviceRGB()
            )
        else { return nil }
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
        return (png, cgImage)
    }

    private func captureFromIOSurface(_ view: NSView) -> Data? {
        captureFromIOSurfaceWithCGImage(view)?.0
    }
    private func captureFromIOSurfaceWithCGImage(_ view: NSView) -> (
        Data, CGImage
    )? {
        guard let displaySubview = view.subviews.first,
            let surface = displaySubview.layer?.contents as? IOSurface
        else { return nil }
        let w = IOSurfaceGetWidth(surface)
        let h = IOSurfaceGetHeight(surface)
        let bpr = IOSurfaceGetBytesPerRow(surface)
        guard w > 0, h > 0 else { return nil }
        // Lock syncs GPU framebuffer to CPU memory before reading pixels; required for coherent read.
        surface.lock(options: .readOnly, seed: nil)
        defer { surface.unlock(options: .readOnly, seed: nil) }
        let base = IOSurfaceGetBaseAddress(surface)
        let dataSize = bpr * h
        let dataCopy = Data(bytes: base, count: dataSize)
        let pf = IOSurfaceGetPixelFormat(surface)
        let bitmapInfo: CGBitmapInfo
        switch pf {
        case 0x4247_5241:
            // kCVPixelFormatType_32BGRA: B,G,R,A in memory (byte 0 = B)
            bitmapInfo = CGBitmapInfo(
                rawValue: CGBitmapInfo.byteOrder32Little.rawValue
                    | CGImageAlphaInfo.noneSkipFirst.rawValue)
        case 0x4142_4752:
            bitmapInfo = CGBitmapInfo(
                rawValue: CGBitmapInfo.byteOrder32Big.rawValue
                    | CGImageAlphaInfo.premultipliedLast.rawValue)
        default:
            bitmapInfo = CGBitmapInfo(
                rawValue: CGBitmapInfo.byteOrder32Little.rawValue
                    | CGImageAlphaInfo.noneSkipFirst.rawValue)
        }
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let provider = CGDataProvider(data: dataCopy as CFData) else { return nil }
        guard
            let cgImage = CGImage(
                width: w,
                height: h,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: bpr,
                space: colorSpace,
                bitmapInfo: bitmapInfo,
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
            )
        else { return nil }
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
        return (png, cgImage)
    }

    private func captureViewLayer(_ view: NSView) -> Data? {
        captureViewLayerWithCGImage(view)?.0
    }
    private func captureViewLayerWithCGImage(_ view: NSView) -> (Data, CGImage)? {
        let layerToRender: CALayer?
        let boundsToUse: CGRect
        if let displaySubview = view.subviews.first,
            displaySubview.layer?.contents is IOSurface
        {
            layerToRender = displaySubview.layer
            boundsToUse = displaySubview.bounds
        } else {
            layerToRender = view.layer
            boundsToUse = view.bounds
        }
        guard let layer = layerToRender, boundsToUse.width > 0, boundsToUse.height > 0 else {
            return nil
        }
        let scale = view.window?.backingScaleFactor ?? 1
        let w = Int(boundsToUse.width * scale)
        let h = Int(boundsToUse.height * scale)
        guard w > 0, h > 0 else { return nil }
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard
            let ctx = CGContext(
                data: nil,
                width: w,
                height: h,
                bitsPerComponent: 8,
                bytesPerRow: w * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { return nil }
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: scale, y: -scale)
        layer.render(in: ctx)
        guard let cgImage = ctx.makeImage() else { return nil }
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
        return (png, cgImage)
    }

    private func keyFromName(_ name: String) -> VZAutomator.Key {
        let parts = name.split(separator: "+").map {
            String($0).trimmingCharacters(in: .whitespaces)
        }
        guard !parts.isEmpty else { return .keyboardReturn }

        var modifiers: VZAutomator.Modifiers = []
        var mainKeyPart: String?
        let modifierNames: Set<String> = [
            "ctrl", "control", "alt", "option", "shift", "cmd", "command", "meta", "super", "win",
            "fn",
        ]

        for part in parts {
            let lower = part.lowercased()
            if modifierNames.contains(lower) {
                switch lower {
                case "ctrl", "control": modifiers.insert(.control)
                case "alt", "option": modifiers.insert(.alt)
                case "shift": modifiers.insert(.shift)
                case "cmd", "command", "meta", "super", "win": modifiers.insert(.command)
                case "fn": modifiers.insert(.fn)
                default: break
                }
            } else {
                mainKeyPart = part
                break
            }
        }

        let mainKey: VZAutomator.Key
        if let part = mainKeyPart ?? parts.last {
            mainKey = baseKeyFromName(String(part))
        } else {
            return .keyboardReturn
        }

        var result = mainKey
        if modifiers.contains(.control) { result = result.modify(.control) }
        if modifiers.contains(.alt) { result = result.modify(.alt) }
        if modifiers.contains(.shift) { result = result.modify(.shift) }
        if modifiers.contains(.command) { result = result.modify(.command) }
        if modifiers.contains(.fn) { result = result.modify(.fn) }
        return result
    }

    private func baseKeyFromName(_ name: String) -> VZAutomator.Key {
        // Handle actual escape chars (in case sent as single chars)
        if name == "\t" { return .keyboardTab }
        if name == "\n" || name == "\r" { return .keyboardReturn }
        if name == "\u{8}" { return .keyboardDelete }  // \b backspace
        switch name.lowercased() {
        case "enter", "return": return .keyboardReturn
        case "tab": return .keyboardTab
        case "escape", "esc": return .keyboardEsc
        case "space", "spacebar": return .keyboardSpacebar
        case "backspace", "backspace2": return .keyboardDelete
        case "delete", "del": return .keyboardDeleteForward
        case "up": return .keyboardUpArrow
        case "down": return .keyboardDownArrow
        case "left": return .keyboardLeftArrow
        case "right": return .keyboardRightArrow
        case "home": return .keyboardHome
        case "end": return .keyboardEnd
        case "page_up", "pageup": return .keyboardPageUp
        case "page_down", "pagedown": return .keyboardPageDown
        case "f1": return .keyboardF1
        case "f2": return .keyboardF2
        case "f3": return .keyboardF3
        case "f4": return .keyboardF4
        case "f5": return .keyboardF5
        case "f6": return .keyboardF6
        case "f7": return .keyboardF7
        case "f8": return .keyboardF8
        case "f9": return .keyboardF9
        case "f10": return .keyboardF10
        case "f11": return .keyboardF11
        case "f12": return .keyboardF12
        case "a": return .keyboardA
        case "b": return .keyboardB
        case "c": return .keyboardC
        case "d": return .keyboardD
        case "e": return .keyboardE
        case "f": return .keyboardF
        case "g": return .keyboardG
        case "h": return .keyboardH
        case "i": return .keyboardI
        case "j": return .keyboardJ
        case "k": return .keyboardK
        case "l": return .keyboardL
        case "m": return .keyboardM
        case "n": return .keyboardN
        case "o": return .keyboardO
        case "p": return .keyboardP
        case "q": return .keyboardQ
        case "r": return .keyboardR
        case "s": return .keyboardS
        case "t": return .keyboardT
        case "u": return .keyboardU
        case "v": return .keyboardV
        case "w": return .keyboardW
        case "x": return .keyboardX
        case "y": return .keyboardY
        case "z": return .keyboardZ
        case "0": return .keyboard0
        case "1": return .keyboard1
        case "2": return .keyboard2
        case "3": return .keyboard3
        case "4": return .keyboard4
        case "5": return .keyboard5
        case "6": return .keyboard6
        case "7": return .keyboard7
        case "8": return .keyboard8
        case "9": return .keyboard9
        case "power": return .keyboardPower
        case "minus", "-": return .keyboardHyphen
        case "equal", "=": return .keyboardEqualSign
        case "bracketleft", "[": return .keyboardOpenBracket
        case "bracketright", "]": return .keyboardCloseBracket
        case "backslash", "\\": return .keyboardBackslash
        case "semicolon", ";": return .keyboardSemicolon
        case "apostrophe", "'": return .keyboardQuote
        case "comma", ",": return .keyboardComma
        case "period", ".": return .keyboardPeriod
        case "slash", "/": return .keyboardSlash
        case "grave", "`": return .keyboardGrave
        default: return .keyboardReturn
        }
    }
}

class VMWindowDelegate: NSObject, NSWindowDelegate {
    let vmId: String

    init(vmId: String) {
        self.vmId = vmId
        super.init()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let running = HoustonVMManager.shared.runningVM, running.id == vmId else {
            return true
        }
        sender.miniaturize(nil)
        print(
            "[HoustonVM] Minimizing VM \(vmId) to dock instead of closing. Use Houston Console to restore."
        )
        return false
    }
}

class VMDelegate: NSObject, VZVirtualMachineDelegate {
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        print("[HoustonVM] VM didStopWithError: \(error.localizedDescription)")
        Task { @MainActor in
            HoustonVMManager.shared.runningVM = nil
        }
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        print("[HoustonVM] VM guestDidStop")
        Task { @MainActor in
            HoustonVMManager.shared.runningVM = nil
        }
    }
}
