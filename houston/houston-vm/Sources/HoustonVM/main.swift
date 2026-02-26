import Foundation
import AppKit
import Swifter

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

@main
struct HoustonVMApp {
    static let houstonDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".houston")
    static let vmPortFile = houstonDir.appendingPathComponent("vm.port")

    /// Run graceful VM shutdown then exit. Used by parent watcher and SIGTERM handler.
    private static func gracefulShutdownAndExit() {
        let sem = DispatchSemaphore(value: 0)
        Task { @MainActor in
            defer { sem.signal() }
            if let id = HoustonVMManager.shared.runningVM?.id {
                do {
                    try await HoustonVMManager.shared.stopVM(id: id, force: false)
                    print("[HoustonVM] VM stopped, exiting")
                } catch {
                    print("[HoustonVM] Stop failed: \(error), forcing exit")
                }
            }
            fflush(stdout)
        }
        _ = sem.wait(timeout: .now() + 30)
        exit(0)
    }

    static func main() async {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        // SIGTERM: when Electron sends kill, do graceful shutdown instead of immediate exit
        signal(SIGTERM, SIG_IGN)
        let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global(qos: .utility))
        sigtermSource.setEventHandler {
            print("[HoustonVM] SIGTERM received, gracefully stopping VM(s) before exit")
            fflush(stdout)
            sigtermSource.cancel()
            gracefulShutdownAndExit()
        }
        sigtermSource.resume()

        if let parentPidStr = ProcessInfo.processInfo.environment["HOUSTON_PARENT_PID"],
           let parentPid = pid_t(parentPidStr) {
            DispatchQueue.global(qos: .utility).async {
                while true {
                    sleep(2)
                    if kill(parentPid, 0) != 0 {
                        print("[HoustonVM] Parent process \(parentPid) is gone, gracefully stopping VM(s) before exit")
                        fflush(stdout)
                        gracefulShutdownAndExit()
                    }
                }
            }
        }

        let server = HttpServer()

        let syncHandleTimeoutSeconds = 120
        func syncHandle(_ method: String, _ path: String, _ body: Data?) -> HttpResponse {
            let sem = DispatchSemaphore(value: 0)
            var result: (Int, Data, String)?
            Task { @MainActor in
                result = await handleRequest(method: method, path: path, body: body)
                sem.signal()
            }
            let waitResult = sem.wait(timeout: .now() + .seconds(syncHandleTimeoutSeconds))
            guard waitResult == .success, let (status, data, contentType) = result else {
                let errMsg = waitResult == .timedOut ? "Request timed out (MainActor may be blocked)" : "Handler failed"
                let errData = (try? JSONSerialization.data(withJSONObject: ["ok": false, "error": errMsg])) ?? Data()
                return .raw(500, "Internal Server Error", ["Content-Type": "application/json"], { try $0.write(errData) })
            }
            let headers: [String: String] = ["Content-Type": contentType, "Content-Length": "\(data.count)"]
            let phrase = status == 200 ? "OK" : status == 400 ? "Bad Request" : status == 404 ? "Not Found" : "Internal Server Error"
            return .raw(status, phrase, headers, { try $0.write(data) })
        }

        server.GET["/vms"] = { req in
            return syncHandle("GET", "/vms", nil)
        }
        server.POST["/check-ipsw"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/check-ipsw", body)
        }
        server.POST["/create"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            print("[HoustonVM] POST /create body=\(body?.count ?? 0) bytes")
            fflush(stdout)
            return syncHandle("POST", "/create", body)
        }
        server.GET["/install-progress/:id"] = { req in
            return syncHandle("GET", "/install-progress/\(req.params[":id"] ?? "")", nil)
        }
        server.POST["/start/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/start/\(req.params[":id"] ?? "")", body)
        }
        server.POST["/stop/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/stop/\(req.params[":id"] ?? "")", body)
        }
        server.POST["/delete/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/delete/\(req.params[":id"] ?? "")", body)
        }
        server.GET["/screenshot/:id"] = { req in
            return syncHandle("GET", "/screenshot/\(req.params[":id"] ?? "")", nil)
        }
        server.POST["/type/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/type/\(req.params[":id"] ?? "")", body)
        }
        server.POST["/press/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/press/\(req.params[":id"] ?? "")", body)
        }
        server.POST["/click/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/click/\(req.params[":id"] ?? "")", body)
        }
        server.POST["/move/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/move/\(req.params[":id"] ?? "")", body)
        }
        server.POST["/mousedown/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/mousedown/\(req.params[":id"] ?? "")", body)
        }
        server.POST["/move-dragging/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/move-dragging/\(req.params[":id"] ?? "")", body)
        }
        server.POST["/mouseup/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/mouseup/\(req.params[":id"] ?? "")", body)
        }
        server.POST["/scroll/:id"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            return syncHandle("POST", "/scroll/\(req.params[":id"] ?? "")", body)
        }
        server.POST["/console/:id"] = { req in
            return syncHandle("POST", "/console/\(req.params[":id"] ?? "")", nil)
        }
        server.GET["/debug/screenshot/:id/method/:method"] = { req in
            return syncHandle("GET", "/debug/screenshot/\(req.params[":id"] ?? "")/method/\(req.params[":method"] ?? "")", nil)
        }
        server.GET["/debug/screenshot/:id/probe"] = { req in
            return syncHandle("GET", "/debug/screenshot/\(req.params[":id"] ?? "")/probe", nil)
        }
        server.GET["/debug/screenshot/:id"] = { req in
            return syncHandle("GET", "/debug/screenshot/\(req.params[":id"] ?? "")", nil)
        }

        do {
            try server.start(0, forceIPv4: true)
            let actualPort = try server.port()
            try FileManager.default.createDirectory(at: houstonDir, withIntermediateDirectories: true)
            try String(actualPort).write(to: vmPortFile, atomically: true, encoding: .utf8)
            print("HoustonVM listening on port \(actualPort)")
            fflush(stdout)
        } catch {
            print("[HoustonVM] Failed to start server: \(error)")
            fflush(stdout)
            exit(1)
        }

        app.run()
    }
}
