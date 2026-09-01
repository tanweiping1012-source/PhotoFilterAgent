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
    /// 做眼部关键点时，那张脸实际有多少像素（取长边）。
    ///
    /// 关键点可不可靠取决于**人脸的像素数**，不是它占画面的比例 ——
    /// 这两件事只有在分辨率固定时才等价。之前用面积比当门槛，
    /// 等于把「原图 7728px 上一张 500px 的脸」和「缩略图上一张 74px 的脸」
    /// 当成同一回事，于是 68% 的照片被无谓地挡掉了。
    let eyeFacePixels: Int?
    /// 眼睛读数是否来自从原图裁出的高清人脸（而非 1024px 缩略图）。
    let eyeFromHiRes: Bool
    /// 主脸的归一化包围盒 [x, y, 宽, 高]，原点在**左下**（Vision 的约定）。
    ///
    /// 为什么要传出去：发给视觉模型的是 512px 小图，而这批环境人像里
    /// 人脸只占画面 0.5% 左右 —— 在小图上只剩 **30 像素**，91% 的照片
    /// 不足 48 像素。模型被要求判断「笑是不是到眼睛里」，但它根本看不见，
    /// 只能猜。有了这个框，就能额外附一张高清人脸给它。
    let faceBox: [Double]?
    /// 人脸俯仰角（弧度，正=低头）。取不到为 nil。
    ///
    /// 为什么必须有它：眼睛纵横比（EAR）分不清「闭眼」和「低头垂眼」——
    /// 低头时眼睑遮住大部分眼球，EAR 同样会掉到很低。
    /// 实测有一张用户自己选进精选的低头照，EAR 只有 0.095（20 张精选里最低，
    /// 次低是 0.262），但人眼一看就是睁着的，只是在低头；它的 pitch 是 15°，
    /// 而正常平视的照片是 5–7°。
    ///
    /// 用户自己也是把这两件事分开判的：标注里「眼睛都没睁开」和「低头看路
    /// 没有视觉引导物」是并列的两条理由。检测器不该把它们压成一个数。
    let pitchRadians: Double?

    /// 眼睛是否明显闭合。阈值偏保守：宁可漏报，不可把睁着的说成闭着的。
    ///
    /// 门槛看的是**人脸像素数**而不是面积占比。有读数就说明那张脸够大，
    /// 因为读数本身只在够大时才会产生（见 analyze）。
    var eyesLikelyClosed: Bool {
        guard let eyeOpenness, eyeOpenness < PortraitQualityAnalyzer.closedEyeThreshold else { return false }
        // 低头时 EAR 天然偏低 —— 那是垂眼不是闭眼，不能按闭眼一票否决。
        // 这类照片改由 headDown 单独报出，让上层决定怎么处理。
        return !isHeadDown
    }

    /// 明显低头。与闭眼互斥：低头压低的 EAR 不算闭眼。
    var isHeadDown: Bool {
        guard let pitchRadians else { return false }
        return pitchRadians > PortraitQualityAnalyzer.headDownThreshold
    }

    /// 给模型看的一行摘要。只陈述事实，不替它下结论。
    var summary: String {
        var parts = ["脸质量\(Int((captureQuality * 100).rounded()))"]
        if faceCount > 1 { parts.append("\(faceCount)张脸") }
        if let eyeOpenness {
            parts.append(eyesLikelyClosed ? "眼睛闭" : "眼睛睁\(Int((eyeOpenness * 100).rounded()))")
        }
        return parts.joined(separator: " ")
    }
}

enum PortraitQualityAnalyzer {
    /// 做眼部关键点所需的最小人脸像素（长边）。
    ///
    /// 换掉了原来的面积占比门槛 0.008。那个门槛本身没错 —— 在 1024px 缩略图上，
    /// 0.8% 面积的脸只有约 74px，关键点确实不可靠。错在**它把分辨率写死了**：
    /// 同样这张脸在 7728px 的原图上有 564px，完全够用。
    ///
    /// 实测代价：面积门槛让 280 张有脸的照片里只有 91 张（32%）拿得到眼睛读数，
    /// 而「眼睛睁没睁开」是用户 35 题标注里 27 题的头号判据 ——
    /// 最强的本地信号在三分之二的照片上根本不存在。
    static let minimumFacePixelsForEyeCheck = 160
    /// 高清补测时，希望把人脸放大到多少像素。超过没有收益，只是多解码。
    static let targetFacePixels = 320
    /// 解码上限。再大只是浪费，且 40MP 全解一次约 0.5–1s。
    static let maximumDecodePixels = 8000

    /// 面积门槛的历史值，仅保留给旧调用点做兼容判断，新逻辑不再使用。
    static let minimumFaceAreaForEyeCheck = 0.008
    /// 睁眼/闭眼的分界。
    ///
    /// 实测标定：同一组人像里闭眼三张的纵横比是 0.15 / 0.12 / 0.09，睁眼三张是
    /// 0.31 / 0.48 / 0.48——中间有很宽的空档，取 0.22 落在空档中央，两侧都有余量。
    /// 早先取 0.11 会把 0.15 和 0.12 那两张明显闭着的判成睁开。
    static let closedEyeThreshold = 0.22
    /// 低头的判定线（弧度）。实测平视 5–7°，明显低头 15°，取 12° 落在空档里。
    static let headDownThreshold = 12.0 * .pi / 180.0

    /// 对一张已解码的图像做人像质量分析。
    ///
    /// - Parameter image: 已解码的图像；用分析管线里那张 1024px 的即可，不重复解码。
    /// - Returns: 检出人脸时返回质量事实；没有人脸返回 nil。
    static func analyze(_ image: CGImage) -> PortraitQuality? {
        analyze(image, source: nil)
    }

    /// 带高清补测的版本。
    ///
    /// `source` 给了之后，遇到在缩略图上太小的脸，会按需从原图解出足够大的一版、
    /// 裁出人脸区域、在高清人脸上重做关键点。给 nil 就退化成只用缩略图。
    static func analyze(_ image: CGImage, source: CGImageSource?) -> PortraitQuality? {
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        let qualityRequest = VNDetectFaceCaptureQualityRequest()
        let landmarksRequest = VNDetectFaceLandmarksRequest()
        // 姿态角只有 rectangles 的 revision 3 才给。默认 revision 下 pitch 恒为 nil ——
        // 实测过，会静默拿到 nan，所以这里必须显式指定。
        let poseRequest = VNDetectFaceRectanglesRequest()
        poseRequest.revision = VNDetectFaceRectanglesRequestRevision3
        do {
            try handler.perform([qualityRequest, landmarksRequest, poseRequest])
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
        // 姿态来自第三个请求，同样按包围盒中心距离对上同一张脸。
        let pose = (poseRequest.results ?? []).min {
            distance($0.boundingBox, primary.boundingBox) < distance($1.boundingBox, primary.boundingBox)
        }
        let pitch = pose?.pitch?.doubleValue
        let box = [Double(primary.boundingBox.minX), Double(primary.boundingBox.minY),
                   Double(primary.boundingBox.width), Double(primary.boundingBox.height)]
        let landmarksFaces = landmarksRequest.results ?? []
        // 关键点与质量分来自两次独立请求，用包围盒中心距离把同一张脸对上。
        let matched = landmarksFaces.min { lhs, rhs in
            distance(lhs.boundingBox, primary.boundingBox)
                < distance(rhs.boundingBox, primary.boundingBox)
        }

        // ── 眼部关键点：先看缩略图上这张脸够不够大 ──────────────────
        //
        // 决定关键点可不可靠的是**人脸的像素数**，不是它占画面的比例。
        // 缩略图长边 1024 时，占画面 0.8% 的脸只有 74px；同一张脸在 7728px
        // 的原图上有 564px。之前用面积占比当门槛，等于把分辨率写死，
        // 结果 68% 的照片拿不到眼睛读数 —— 而那是用户的头号判据。
        let thumbFacePx = Int((max(primary.boundingBox.width * CGFloat(image.width),
                                   primary.boundingBox.height * CGFloat(image.height))).rounded())

        if thumbFacePx >= minimumFacePixelsForEyeCheck, let openness = matched.flatMap(eyeOpenness(of:)) {
            // 缩略图上就够大，不必多解一次原图。
            return PortraitQuality(
                captureQuality: Double(primary.faceCaptureQuality ?? 0),
                faceAreaRatio: area,
                eyeOpenness: openness,
                faceCount: faces.count,
                eyeFacePixels: thumbFacePx,
                eyeFromHiRes: false,
                faceBox: box,
                pitchRadians: pitch
            )
        }

        // 缩略图上太小 —— 从原图裁高清人脸重做一次。
        if let source,
           let hi = hiResEyeOpenness(source: source, box: primary.boundingBox,
                                     thumbSize: CGSize(width: image.width, height: image.height)) {
            return PortraitQuality(
                captureQuality: Double(primary.faceCaptureQuality ?? 0),
                faceAreaRatio: area,
                eyeOpenness: hi.openness,
                faceCount: faces.count,
                eyeFacePixels: hi.facePixels,
                eyeFromHiRes: true,
                faceBox: box,
                pitchRadians: pitch
            )
        }

        // 补测也拿不到：如实返回没有眼睛读数，不要拿不可靠的值冒充。
        return PortraitQuality(
            captureQuality: Double(primary.faceCaptureQuality ?? 0),
            faceAreaRatio: area,
            eyeOpenness: nil,
            faceCount: faces.count,
            eyeFacePixels: nil,
            eyeFromHiRes: false,
            faceBox: box,
            pitchRadians: pitch
        )
    }

    /// 从原图裁出高清人脸，重做眼部关键点。
    ///
    /// 解码尺寸按需计算：把人脸放大到 `targetFacePixels` 就够，再大只是多花时间。
    /// 40MP 全解一次约 0.5–1s，所以只在缩略图上判不出来时才走这条路。
    private static func hiResEyeOpenness(
        source: CGImageSource, box: CGRect, thumbSize: CGSize
    ) -> (openness: Double, facePixels: Int)? {
        // 解码尺寸要按长宽比换算，不能直接用 box 的比例。
        //
        // maximumPixelSize 限制的是**长边**。设长边解到 M、长宽比 a = W/H（横图 a>1），
        // 则宽 = M、高 = M/a，人脸像素 = M · max(box.width, box.height / a)。
        // 第一版漏了 /a，横图上人脸恒定小 a 倍 —— 实测目标 320px 全部落成 213px。
        let aspect = max(Double(thumbSize.width) / Double(max(thumbSize.height, 1)), 0.0001)
        let facePerUnit = max(Double(box.width), Double(box.height) / aspect)
        guard facePerUnit > 0 else { return nil }
        let needed = min(Double(targetFacePixels) / facePerUnit, Double(maximumDecodePixels))
        guard let full = PhotoAnalysisPipeline.decodedImage(
            from: source, maximumPixelSize: Int(needed.rounded())
        ) else { return nil }

        let W = CGFloat(full.width), H = CGFloat(full.height)
        // Vision 的 boundingBox 原点在**左下**，CGImage 裁剪原点在左上，Y 要翻。
        // 外扩 60%：关键点检测需要看到眉毛与脸颊，只给眼眶会检不出。
        let pad: CGFloat = 0.6
        let w = box.width * W, h = box.height * H
        var rect = CGRect(x: box.minX * W - w * pad / 2,
                          y: (1 - box.maxY) * H - h * pad / 2,
                          width: w * (1 + pad), height: h * (1 + pad))
        rect = rect.intersection(CGRect(x: 0, y: 0, width: W, height: H))
        guard rect.width >= 1, rect.height >= 1, let crop = full.cropping(to: rect) else { return nil }

        let facePx = Int(max(w, h).rounded())
        guard facePx >= minimumFacePixelsForEyeCheck else { return nil }

        let req = VNDetectFaceLandmarksRequest()
        do { try VNImageRequestHandler(cgImage: crop, options: [:]).perform([req]) }
        catch { return nil }
        // 裁剪后画面里应该只剩这一张脸；仍取最大的那张以防背景里混入路人。
        guard let face = (req.results ?? []).max(by: {
            $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height
        }), let openness = eyeOpenness(of: face) else { return nil }
        return (openness, facePx)
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
