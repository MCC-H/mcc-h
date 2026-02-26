import Foundation
import Swifter
import Vision
import CoreML
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

@main
struct HoustonAIApp {
    static let houstonDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".houston")
    static let aiPortFile = houstonDir.appendingPathComponent("ai.port")

    static func main() {
        signal(SIGTERM, SIG_IGN)
        let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global(qos: .utility))
        sigtermSource.setEventHandler {
            print("[HoustonAI] SIGTERM received, exiting")
            fflush(stdout)
            sigtermSource.cancel()
            exit(0)
        }
        sigtermSource.resume()

        // Parent watcher: exit when Electron (main Houston) dies
        if let parentPidStr = ProcessInfo.processInfo.environment["HOUSTON_PARENT_PID"],
           let parentPid = pid_t(parentPidStr) {
            DispatchQueue.global(qos: .utility).async {
                while true {
                    sleep(2)
                    if kill(parentPid, 0) != 0 {
                        print("[HoustonAI] Parent process \(parentPid) is gone, exiting")
                        fflush(stdout)
                        exit(0)
                    }
                }
            }
        }

        let server = HttpServer()

        server.POST["/ocr"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            guard let body = body,
                  let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let base64 = obj["image_base64"] as? String,
                  let data = Data(base64Encoded: base64)
            else {
                return .raw(400, "Bad Request", ["Content-Type": "application/json"]) {
                    try $0.write((try? JSONSerialization.data(withJSONObject: ["ok": false, "error": "Missing image_base64"])) ?? Data())
                }
            }
            let result = runOCR(imageData: data)
            return .raw(200, "OK", ["Content-Type": "application/json"]) {
                try $0.write((try? JSONSerialization.data(withJSONObject: result)) ?? Data())
            }
        }

        server.POST["/captions"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            guard let body = body,
                  let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let images = obj["images"] as? [String]
            else {
                return .raw(400, "Bad Request", ["Content-Type": "application/json"]) {
                    try $0.write((try? JSONSerialization.data(withJSONObject: ["ok": false, "error": "Missing images"])) ?? Data())
                }
            }
            let captions = runCaptions(images: images)
            return .raw(200, "OK", ["Content-Type": "application/json"]) {
                try $0.write((try? JSONSerialization.data(withJSONObject: ["ok": true, "captions": captions])) ?? Data())
            }
        }

        server.POST["/ocr-omni-parser"] = { req in
            let body = req.body.isEmpty ? nil : Data(req.body)
            guard let body = body,
                  let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let base64 = obj["image_base64"] as? String,
                  let data = Data(base64Encoded: base64)
            else {
                return .raw(400, "Bad Request", ["Content-Type": "application/json"]) {
                    try $0.write((try? JSONSerialization.data(withJSONObject: ["ok": false, "error": "Missing image_base64"])) ?? Data())
                }
            }
            let result = runOmniParser(imageData: data)
            return .raw(200, "OK", ["Content-Type": "application/json"]) {
                try $0.write((try? JSONSerialization.data(withJSONObject: result)) ?? Data())
            }
        }

        server.GET["/models-status"] = { _ in
            let status = modelsStatus()
            return .raw(200, "OK", ["Content-Type": "application/json"]) {
                try $0.write((try? JSONSerialization.data(withJSONObject: status)) ?? Data())
            }
        }

        do {
            try server.start(0, forceIPv4: true)
            let actualPort = try server.port()
            try FileManager.default.createDirectory(at: houstonDir, withIntermediateDirectories: true)
            try String(actualPort).write(to: aiPortFile, atomically: true, encoding: .utf8)
            print("HoustonAI listening on port \(actualPort)")
            fflush(stdout)
            OCRDetectors.preloadModels()
        } catch {
            print("[HoustonAI] Failed to start server: \(error)")
            fflush(stdout)
            exit(1)
        }

        RunLoop.main.run()
    }

    static func runOCR(imageData: Data) -> [String: Any] {
        guard let cgImage = createCGImage(from: imageData) else {
            return ["image": [0, 0], "checkboxes": [] as [[String: Any]], "radio_buttons": [] as [[String: Any]], "ui_elements": [] as [[String: Any]], "texts": [] as [[String: Any]]]
        }
        let w = cgImage.width
        let h = cgImage.height

        var texts: [[String: Any]] = []
        let request = VNRecognizeTextRequest { request, error in
            guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
            for obs in observations {
                guard let top = obs.topCandidates(1).first else { continue }
                let bbox = obs.boundingBox
                let minX = Double(bbox.minX), maxX = Double(bbox.maxX)
                let minY = Double(bbox.minY), maxY = Double(bbox.maxY)
                let centerX = Int(round((minX + maxX) / 2.0 * Double(w)))
                let centerY = Int(round(Double(h) - (minY + maxY) / 2.0 * Double(h)))
                let x1 = Int(round(minX * Double(w)))
                let y1 = Int(round(Double(h) - maxY * Double(h)))
                let x2 = Int(round(maxX * Double(w)))
                let y2 = Int(round(Double(h) - minY * Double(h)))
                texts.append([
                    "text": top.string,
                    "center": [centerX, centerY],
                    "bbox2d": [x1, y1, x2, y2],
                ])
            }
        }
        request.recognitionLevel = VNRequestTextRecognitionLevel.accurate
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try? handler.perform([request])

        let (checkboxes, radioButtons) = OCRDetectors.runCheckboxDetector(cgImage: cgImage, imgW: w, imgH: h)
        let uiElements = OCRDetectors.runUIElementsDetectors(cgImage: cgImage, imgW: w, imgH: h)

        return [
            "image": [w, h],
            "checkboxes": checkboxes,
            "radio_buttons": radioButtons,
            "ui_elements": uiElements,
            "texts": texts,
        ]
    }

    static func runCaptions(images: [String]) -> [[String: String]] {
        images.map { _ in ["label": "", "description": ""] }
    }

    static func runOmniParser(imageData: Data) -> [String: Any] {
        runOCR(imageData: imageData)
    }

    static func modelsStatus() -> [String: Any] {
        ["ok": true, "models": [String: String](), "isComplete": true]
    }

    static func createCGImage(from data: Data) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil)
        else { return nil }
        return cgImage
    }
}
