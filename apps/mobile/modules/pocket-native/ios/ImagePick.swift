import ExpoModulesCore
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/**
 * Pictures to send to an agent, the iOS side of ImagePick.kt: the system photo
 * picker (PHPicker, no photo library permission needed), then each picture
 * turned upright and shrunk to a JPEG whose longest side is at most `maxSide`.
 * Same output as Android: {name, mime, data (base64), width, height, bytes}.
 */
final class ImagePick: NSObject, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  /// The pick on screen; holds itself until the picker answers.
  private static var pending: ImagePick?

  private let promise: Promise
  private let max: Int
  private let maxSide: Int
  private let quality: Int
  private var answered = false
  private let answerLock = NSLock()

  private init(promise: Promise, max: Int, maxSide: Int, quality: Int) {
    self.promise = promise
    self.max = Swift.min(Swift.max(max, 1), 20)
    self.maxSide = Swift.min(Swift.max(maxSide, 256), 4096)
    self.quality = Swift.min(Swift.max(quality, 40), 95)
  }

  /// On the main thread.
  static func start(from presenter: UIViewController, promise: Promise, max: Int, maxSide: Int, quality: Int) {
    // A pick that never came back ends as cancelled.
    pending?.finish([])
    let pick = ImagePick(promise: promise, max: max, maxSide: maxSide, quality: quality)
    pending = pick
    var config = PHPickerConfiguration()
    config.filter = .images
    config.selectionLimit = pick.max
    config.preferredAssetRepresentationMode = .current
    if #available(iOS 15.0, *) { config.selection = .ordered }
    let picker = PHPickerViewController(configuration: config)
    picker.delegate = pick
    picker.presentationController?.delegate = pick
    presenter.present(picker, animated: true)
  }

  /// Once only: the picker and a swipe-down can both report.
  private func answer() -> Bool {
    answerLock.lock()
    defer { answerLock.unlock() }
    if answered { return false }
    answered = true
    return true
  }

  private func finish(_ list: [[String: Any]]) {
    guard answer() else { return }
    promise.resolve(list)
    release()
  }

  private func fail(_ message: String) {
    guard answer() else { return }
    promise.reject("E_IMAGE", message)
    release()
  }

  private func release() {
    DispatchQueue.main.async { if ImagePick.pending === self { ImagePick.pending = nil } }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish([])
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    let picked = Array(results.prefix(max))
    if picked.isEmpty {
      finish([])
      return
    }
    // Loading and shrinking a large photo takes a moment: off the main thread, in the order picked.
    var datas = [Data?](repeating: nil, count: picked.count)
    let group = DispatchGroup()
    let lock = NSLock()
    for (i, result) in picked.enumerated() {
      group.enter()
      result.itemProvider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
        lock.lock()
        datas[i] = data
        lock.unlock()
        group.leave()
      }
    }
    let names = picked.map { $0.itemProvider.suggestedName }
    group.notify(queue: .global(qos: .userInitiated)) {
      var out: [[String: Any]] = []
      for (i, data) in datas.enumerated() {
        guard let data, let item = ImagePick.encode(data, name: names[i], maxSide: self.maxSide, quality: self.quality) else {
          self.fail("could not read the picture")
          return
        }
        out.append(item)
      }
      self.finish(out)
    }
  }

  static func encode(_ data: Data, name: String?, maxSide: Int, quality: Int) -> [String: Any]? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    // Upright (EXIF orientation applied) and at most maxSide on its longest side; HEIC reads too.
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxSide,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    let size = CGSize(width: image.width, height: image.height)
    // JPEG has no transparency: transparent parts go on white instead of black.
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let flat = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
      UIColor.white.setFill()
      ctx.fill(CGRect(origin: .zero, size: size))
      UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: size))
    }
    guard let jpeg = flat.jpegData(compressionQuality: CGFloat(quality) / 100) else { return nil }
    var stem = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if let dot = stem.lastIndex(of: "."), dot != stem.startIndex { stem = String(stem[..<dot]) }
    if stem.isEmpty { stem = "image" }
    return [
      "name": "\(stem).jpg",
      "mime": "image/jpeg",
      "data": jpeg.base64EncodedString(),
      "width": image.width,
      "height": image.height,
      "bytes": jpeg.count,
    ]
  }
}
