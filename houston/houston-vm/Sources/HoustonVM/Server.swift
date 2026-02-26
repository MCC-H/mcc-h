import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

@MainActor
func handleRequest(method: String, path: String, body: Data?) async -> (Int, Data, String) {
    let manager = HoustonVMManager.shared
    print("[HoustonVM] handleRequest \(method) \(path)")
    fflush(stdout)

    func jsonResponse(_ data: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: data)) ?? Data()
    }

    switch (method, path) {
    case ("GET", "/vms"):
        let vms = manager.listVMs()
        print("[HoustonVM] listVMs -> \(vms.count) vms")
        return (200, jsonResponse(["ok": true, "vms": vms]), "application/json")

    case ("POST", "/check-ipsw"):
        var ipswPath: String?
        if let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let path = obj["ipsw_path"] as? String, !path.isEmpty
        {
            ipswPath = path
        }
        guard let path = ipswPath else {
            return (
                400, jsonResponse(["ok": false, "error": "Missing ipsw_path"]), "application/json"
            )
        }
        let supported = await manager.checkIpswSupported(path: path)
        return (200, jsonResponse(["ok": true, "supported": supported]), "application/json")

    case ("POST", "/create"):
        var guestType = "linux"
        var isoPath: String?
        var ipswPath: String?
        var ramMb: Int?
        var diskGb: Int?
        if let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        {
            if let gt = obj["guest_type"] as? String, !gt.isEmpty { guestType = gt }
            if let path = obj["iso_path"] as? String, !path.isEmpty { isoPath = path }
            if let path = obj["ipsw_path"] as? String, !path.isEmpty { ipswPath = path }
            if let n = obj["ram_mb"] as? NSNumber { ramMb = n.intValue }
            if let n = obj["disk_gb"] as? NSNumber { diskGb = n.intValue }
        }
        print(
            "[HoustonVM] POST /create guestType=\(guestType) isoPath=\(isoPath ?? "nil") ipswPath=\(ipswPath ?? "nil") ramMb=\(ramMb?.description ?? "nil") diskGb=\(diskGb?.description ?? "nil")"
        )
        fflush(stdout)
        do {
            let vm = try manager.createVM(
                guestType: guestType, isoPath: isoPath, ipswPath: ipswPath,
                ramMb: ramMb, diskGb: diskGb)
            return (200, jsonResponse(["ok": true, "vm": vm]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("GET", _) where path.hasPrefix("/install-progress/"):
        let id = String(path.dropFirst("/install-progress/".count))
        if let prog = manager.installProgress(id: id) {
            return (
                200,
                jsonResponse([
                    "ok": true, "fractionCompleted": prog.fractionCompleted, "phase": prog.phase,
                ]), "application/json"
            )
        }
        return (404, jsonResponse(["ok": false, "error": "Not installing"]), "application/json")

    case ("POST", _) where path.hasPrefix("/start/"):
        let id = String(path.dropFirst("/start/".count))
        guard !id.isEmpty else {
            return (400, jsonResponse(["ok": false, "error": "Missing vm id"]), "application/json")
        }
        do {
            try await manager.startVM(id: id)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/stop/"):
        let id = String(path.dropFirst("/stop/".count))
        guard !id.isEmpty else {
            return (400, jsonResponse(["ok": false, "error": "Missing vm id"]), "application/json")
        }
        var force = false
        if let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let f = (obj["force"] as? NSNumber)?.boolValue
        {
            force = f
        }
        do {
            try await manager.stopVM(id: id, force: force)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/delete/"):
        let id = String(path.dropFirst("/delete/".count))
        guard !id.isEmpty else {
            return (400, jsonResponse(["ok": false, "error": "Missing vm id"]), "application/json")
        }
        do {
            try await manager.deleteVM(id: id)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("GET", _) where path.hasPrefix("/screenshot/"):
        let id = String(path.dropFirst("/screenshot/".count))
        do {
            if let png = try await manager.screenshot(id: id) {
                return (200, png, "image/png")
            }
            return (
                404, jsonResponse(["ok": false, "error": "VM not running"]), "application/json"
            )
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/type/"):
        let id = String(path.dropFirst("/type/".count))
        guard let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let text = obj["text"] as? String
        else {
            return (400, jsonResponse(["ok": false, "error": "Missing text"]), "application/json")
        }
        do {
            try await manager.typeText(id: id, text: text)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/press/"):
        let id = String(path.dropFirst("/press/".count))
        guard let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let key = obj["key"] as? String
        else {
            return (400, jsonResponse(["ok": false, "error": "Missing key"]), "application/json")
        }
        do {
            try await manager.pressKey(id: id, key: key)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/click/"):
        let id = String(path.dropFirst("/click/".count))
        var x: Double?
        var y: Double?
        var doubleClick = false
        if let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        {
            x = (obj["x"] as? NSNumber)?.doubleValue
            y = (obj["y"] as? NSNumber)?.doubleValue
            doubleClick = (obj["doubleClick"] as? NSNumber)?.boolValue ?? false
        }
        do {
            try await manager.click(id: id, x: x, y: y, doubleClick: doubleClick)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/move/"):
        let id = String(path.dropFirst("/move/".count))
        guard let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let x = (obj["x"] as? NSNumber)?.doubleValue,
            let y = (obj["y"] as? NSNumber)?.doubleValue
        else {
            return (400, jsonResponse(["ok": false, "error": "Missing x, y"]), "application/json")
        }
        do {
            try await manager.moveMouse(id: id, x: x, y: y)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/mousedown/"):
        let id = String(path.dropFirst("/mousedown/".count))
        guard let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let x = (obj["x"] as? NSNumber)?.doubleValue,
            let y = (obj["y"] as? NSNumber)?.doubleValue
        else {
            return (400, jsonResponse(["ok": false, "error": "Missing x, y"]), "application/json")
        }
        do {
            try await manager.mouseDown(id: id, x: x, y: y)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/move-dragging/"):
        let id = String(path.dropFirst("/move-dragging/".count))
        guard let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let x = (obj["x"] as? NSNumber)?.doubleValue,
            let y = (obj["y"] as? NSNumber)?.doubleValue
        else {
            return (400, jsonResponse(["ok": false, "error": "Missing x, y"]), "application/json")
        }
        do {
            try await manager.moveMouseDragging(id: id, x: x, y: y)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/mouseup/"):
        let id = String(path.dropFirst("/mouseup/".count))
        guard let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let x = (obj["x"] as? NSNumber)?.doubleValue,
            let y = (obj["y"] as? NSNumber)?.doubleValue
        else {
            return (400, jsonResponse(["ok": false, "error": "Missing x, y"]), "application/json")
        }
        do {
            try await manager.mouseUp(id: id, x: x, y: y)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/scroll/"):
        let id = String(path.dropFirst("/scroll/".count))
        var x: Double?
        var y: Double?
        var scrollX: Double = 0
        var scrollY: Double = 0
        if let body = body,
            let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        {
            x = (obj["x"] as? NSNumber)?.doubleValue
            y = (obj["y"] as? NSNumber)?.doubleValue
            scrollX = (obj["scrollX"] as? NSNumber)?.doubleValue ?? 0
            scrollY = (obj["scrollY"] as? NSNumber)?.doubleValue ?? 0
        }
        if scrollX == 0 && scrollY == 0 {
            return (400, jsonResponse(["ok": false, "error": "Missing scrollX or scrollY"]), "application/json")
        }
        // API: scrollY/scrollX in wheel clicks (lines). + = up/left, - = down/right.
        do {
            try await manager.scroll(id: id, x: x, y: y, deltaX: scrollX, deltaY: scrollY)
            return (200, jsonResponse(["ok": true]), "application/json")
        } catch {
            return (
                500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                "application/json"
            )
        }

    case ("POST", _) where path.hasPrefix("/console/"):
        let id = String(path.dropFirst("/console/".count))
        manager.showConsole(id: id)
        return (200, jsonResponse(["ok": true]), "application/json")

    case ("GET", _) where path.hasPrefix("/debug/screenshot/"):
        let suffix = String(path.dropFirst("/debug/screenshot/".count))
        let parts = suffix.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
        let id = String(parts[0])
        let subPath = parts.count > 1 ? String(parts[1]) : ""
        if subPath == "probe" {
            if let result = await manager.screenshotProbe(id: id) {
                var resp: [String: Any] = ["ok": true]
                for (k, v) in result { resp[k] = v }
                return (200, jsonResponse(resp), "application/json")
            }
            return (
                404, jsonResponse(["ok": false, "error": "VM not running"]), "application/json"
            )
        }
        if subPath.hasPrefix("method/") {
            let method = String(subPath.dropFirst("method/".count))
            do {
                if let png = try await manager.screenshotWithMethod(id: id, method: method) {
                    return (200, png, "image/png")
                }
                return (
                    404, jsonResponse(["ok": false, "error": "Method failed or VM not running"]),
                    "application/json"
                )
            } catch {
                return (
                    500, jsonResponse(["ok": false, "error": error.localizedDescription]),
                    "application/json"
                )
            }
        }
        if let info = manager.screenshotDebugInfo(id: id) {
            return (200, jsonResponse(["ok": true, "info": info]), "application/json")
        }
        return (404, jsonResponse(["ok": false, "error": "VM not running"]), "application/json")

    default:
        return (404, jsonResponse(["ok": false, "error": "Not found"]), "application/json")
    }
}
