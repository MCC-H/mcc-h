import Foundation
import CoreML
import Vision
import CoreGraphics
import ImageIO

/// Run CheckboxDetector, OmniParserDetector, UIElementsDetector on image.
/// Models are loaded from current working directory (dist-electron/resources when launched by Electron).
/// Models are cached after first load to avoid recompiling on every OCR request.
struct OCRDetectors {
    static let confidenceThreshold: Float = 0.25
    static let iouThreshold: Float = 0.7

    private static var modelCache: [String: MLModel] = [:]
    private static let cacheLock = NSLock()

    /// Preload models in background. Call at startup to avoid slow first OCR.
    static func preloadModels() {
        DispatchQueue.global(qos: .utility).async {
            _ = loadModel(name: "CheckboxDetector")
            _ = loadModel(name: "OmniParserDetector")
            _ = loadModel(name: "UIElementsDetector")
            print("[HoustonAI] OCR detector models preloaded")
            fflush(stdout)
        }
    }

    /// Detect checkboxes and radio buttons using CheckboxDetector.
    /// Classes: 0=unchecked, 1=checked, 2=mst (radio).
    static func runCheckboxDetector(cgImage: CGImage, imgW: Int, imgH: Int) -> (checkboxes: [[String: Any]], radioButtons: [[String: Any]]) {
        var checkboxes: [[String: Any]] = []
        var radioButtons: [[String: Any]] = []
        guard let model = loadModel(name: "CheckboxDetector") else { return (checkboxes, radioButtons) }
        guard let visionModel = try? VNCoreMLModel(for: model) else { return (checkboxes, radioButtons) }

        let request = VNCoreMLRequest(model: visionModel)
        request.imageCropAndScaleOption = .scaleFill

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try? handler.perform([request])

        guard let results = request.results as? [VNRecognizedObjectObservation] else { return (checkboxes, radioButtons) }

        for obs in results {
            guard let label = obs.labels.first, label.confidence >= confidenceThreshold else { continue }
            let state = label.identifier == "checked" ? "checked" : "unchecked"
            let bbox = obs.boundingBox
            let x1 = Int(round(bbox.minX * Double(imgW)))
            let y1 = Int(round(Double(imgH) - bbox.maxY * Double(imgH)))
            let x2 = Int(round(bbox.maxX * Double(imgW)))
            let y2 = Int(round(Double(imgH) - bbox.minY * Double(imgH)))
            let centerX = (x1 + x2) / 2
            let centerY = (y1 + y2) / 2
            let item: [String: Any] = [
                "center": [centerX, centerY],
                "bbox2d": [x1, y1, x2, y2],
                "state": state,
                "text": "",
            ]
            if label.identifier == "mst" {
                radioButtons.append(item)
            } else {
                checkboxes.append(item)
            }
        }
        return (checkboxes, radioButtons)
    }

    /// Detect UI elements using OmniParserDetector and UIElementsDetector.
    static func runUIElementsDetectors(cgImage: CGImage, imgW: Int, imgH: Int) -> [[String: Any]] {
        var elements: [[String: Any]] = []
        for name in ["OmniParserDetector", "UIElementsDetector"] {
            guard let model = loadModel(name: name) else { continue }
            guard let visionModel = try? VNCoreMLModel(for: model) else { continue }

            let request = VNCoreMLRequest(model: visionModel)
            request.imageCropAndScaleOption = .scaleFill

            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            try? handler.perform([request])

            guard let results = request.results as? [VNRecognizedObjectObservation] else { continue }

            for obs in results {
                guard let label = obs.labels.first, label.confidence >= confidenceThreshold else { continue }
                let bbox = obs.boundingBox
                let x1 = Int(round(bbox.minX * Double(imgW)))
                let y1 = Int(round(Double(imgH) - bbox.maxY * Double(imgH)))
                let x2 = Int(round(bbox.maxX * Double(imgW)))
                let y2 = Int(round(Double(imgH) - bbox.minY * Double(imgH)))
                let centerX = (x1 + x2) / 2
                let centerY = (y1 + y2) / 2
                elements.append([
                    "center": [centerX, centerY],
                    "bbox2d": [x1, y1, x2, y2],
                    "label": "icon",
                    "caption": label.identifier,
                ])
            }
        }
        return elements
    }

    private static func loadModel(name: String) -> MLModel? {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if let cached = modelCache[name] { return cached }
        let cwd = FileManager.default.currentDirectoryPath
        let pkgPath = (cwd as NSString).appendingPathComponent("\(name).mlpackage")
        let pkgURL = URL(fileURLWithPath: pkgPath)
        guard FileManager.default.fileExists(atPath: pkgPath) else {
            print("[HoustonAI] \(name).mlpackage not found at \(pkgPath)")
            return nil
        }
        do {
            let compiledURL = try MLModel.compileModel(at: pkgURL)
            let model = try MLModel(contentsOf: compiledURL)
            modelCache[name] = model
            return model
        } catch {
            print("[HoustonAI] Failed to load \(name): \(error)")
            return nil
        }
    }
}
