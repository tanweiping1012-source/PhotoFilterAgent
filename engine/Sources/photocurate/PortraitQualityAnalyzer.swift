import CoreGraphics
import Foundation
import Vision

/// 一张人物照里"脸拍得怎么样"。
///
/// 存在的理由很具体：模型在 512px 上能看清眼睛是闭的——它甚至会明说"闭目瞬间富有感染力"——
/// 但闭眼对"帮我挑旅行照片"来说是硬伤而不是风格。与其指望模型自己领会，
/// 不如在本机把事实算出来直接告诉它。
///
/// 这些全部免费、离线、每张都有：`VNDetectFaceCaptureQualityRequest` 引擎里本来就在跑，
/// 只是之前只用来做人物/风景分类，分数从没往外传。
struct PortraitQuality: Equatable, Sendable {
    /// Apple 的人脸拍摄质量分（0–1）。它综合了曝光、清晰度、遮挡与朝向。
    let captureQuality: Double
    /// 主脸在画面里占的面积比例。太小的脸判不出眼睛，也不该按人像标准要求。
    let faceAreaRatio: Double
    /// 眼睛开合度（0–1，越大越睁开）；取不到关键点时为 nil。
    let eyeOpenness: Double?
    /// 检出的人脸数量。
    let faceCount: Int

    /// 眼睛是否明显闭合。阈值偏保守：宁可漏报，不可把睁着的说成闭着的。
    var eyesLikelyClosed: Bool {
        guard let eyeOpenness, faceAreaRatio >= PortraitQualityAnalyzer.minimumFaceAreaForEyeCheck else {
            return false
        }
        return eyeOpenness < PortraitQualityAnalyzer.closedEyeThreshold
    }

    /// 给模型看的一行摘要。只陈述事实，不替它下结论。
    var summary: String {
        var parts = ["脸质量\(Int((captureQuality * 100).rounded()))"]
        if faceCount > 1 { parts.append("\(faceCount)张脸") }
        if let eyeOpenness, faceAreaRatio >= PortraitQualityAnalyzer.minimumFaceAreaForEyeCheck {
            parts.append(eyesLikelyClosed ? "眼睛闭" : "眼睛睁\(Int((eyeOpenness * 100).rounded()))")
        }
        return parts.joined(separator: " ")
    }
}

enum PortraitQualityAnalyzer {
    /// 小于这个面积占比的脸不做眼睛判定：关键点在小脸上不可靠。
    static let minimumFaceAreaForEyeCheck = 0.008
    /// 睁眼/闭眼的分界。
    ///
    /// 实测标定：同一组人像里闭眼三张的纵横比是 0.15 / 0.12 / 0.09，睁眼三张是
    /// 0.31 / 0.48 / 0.48——中间有很宽的空档，取 0.22 落在空档中央，两侧都有余量。
    /// 早先取 0.11 会把 0.15 和 0.12 那两张明显闭着的判成睁开。
    static let closedEyeThreshold = 0.22

    /// 对一张已解码的图像做人像质量分析。
    ///
    /// - Parameter image: 已解码的图像；用分析管线里那张 1024px 的即可，不重复解码。
    /// - Returns: 检出人脸时返回质量事实；没有人脸返回 nil。
    static func analyze(_ image: CGImage) -> PortraitQuality? {
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        let qualityRequest = VNDetectFaceCaptureQualityRequest()
        let landmarksRequest = VNDetectFaceLandmarksRequest()
        do {
            try handler.perform([qualityRequest, landmarksRequest])
        } catch {
            return nil
        }

        let faces = qualityRequest.results ?? []
        guard !faces.isEmpty else { return nil }

        // 以画面里最大的那张脸为准：旅行人像的主体几乎总是离镜头最近的人，
        // 背景路人的脸不该影响这张照片的判定。
        let primary = faces.max { lhs, rhs in
            lhs.boundingBox.width * lhs.boundingBox.height
                < rhs.boundingBox.width * rhs.boundingBox.height
        }
        guard let primary else { return nil }

        let area = Double(primary.boundingBox.width * primary.boundingBox.height)
        let landmarksFaces = landmarksRequest.results ?? []
        // 关键点与质量分来自两次独立请求，用包围盒中心距离把同一张脸对上。
        let matched = landmarksFaces.min { lhs, rhs in
            distance(lhs.boundingBox, primary.boundingBox)
                < distance(rhs.boundingBox, primary.boundingBox)
        }

        return PortraitQuality(
            captureQuality: Double(primary.faceCaptureQuality ?? 0),
            faceAreaRatio: area,
            eyeOpenness: matched.flatMap(eyeOpenness(of:)),
            faceCount: faces.count
        )
    }

    private static func distance(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
        let dx = lhs.midX - rhs.midX
        let dy = lhs.midY - rhs.midY
        return dx * dx + dy * dy
    }

    /// 双眼纵横比的均值。
    ///
    /// 眼睛轮廓的"高/宽"在睁开时明显大于闭合时——这是判断眨眼的标准做法，
    /// 不依赖任何需要联网的模型。
    private static func eyeOpenness(of face: VNFaceObservation) -> Double? {
        guard let landmarks = face.landmarks else { return nil }
        let ratios = [landmarks.leftEye, landmarks.rightEye].compactMap { region -> Double? in
            guard let points = region?.normalizedPoints, points.count >= 4 else { return nil }
            let xs = points.map(\.x)
            let ys = points.map(\.y)
            guard let minX = xs.min(), let maxX = xs.max(),
                  let minY = ys.min(), let maxY = ys.max() else { return nil }
            let width = Double(maxX - minX)
            let height = Double(maxY - minY)
            guard width > 0 else { return nil }
            return height / width
        }
        guard !ratios.isEmpty else { return nil }
        return ratios.reduce(0, +) / Double(ratios.count)
    }
}
