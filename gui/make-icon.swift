// gui/make-icon.swift — draws Icon B (targeting cursor) into AppIcon.iconset PNGs.
//   swift gui/make-icon.swift <outDir>     (default: AppIcon.iconset)
import AppKit

func draw(_ size: Int) -> Data {
    let s = CGFloat(size)
    let img = NSImage(size: NSSize(width: s, height: s))
    img.lockFocus()
    let ctx = NSGraphicsContext.current!.cgContext

    // squircle background
    let inset = s * 0.06
    let rect = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let bg = NSBezierPath(roundedRect: rect, xRadius: s * 0.22, yRadius: s * 0.22)
    let grad = NSGradient(starting: NSColor(white: 0.17, alpha: 1),
                          ending: NSColor(white: 0.09, alpha: 1))!
    grad.draw(in: bg, angle: -70)

    // targeting brackets
    ctx.setStrokeColor(NSColor(white: 0.92, alpha: 1).cgColor)
    ctx.setLineWidth(s * 0.045); ctx.setLineCap(.round)
    let m = s * 0.30, b = s * 0.10
    func bracket(_ cx: CGFloat, _ cy: CGFloat, _ dx: CGFloat, _ dy: CGFloat) {
        ctx.move(to: CGPoint(x: cx, y: cy + dy * b))
        ctx.addLine(to: CGPoint(x: cx, y: cy))
        ctx.addLine(to: CGPoint(x: cx + dx * b, y: cy))
        ctx.strokePath()
    }
    bracket(m, s - m, 1, -1); bracket(s - m, s - m, -1, -1)
    bracket(m, m, 1, 1); bracket(s - m, m, -1, 1)

    // cursor arrow (center)
    let c = s * 0.5
    ctx.setFillColor(NSColor(white: 0.92, alpha: 1).cgColor)
    ctx.move(to: CGPoint(x: c - s * 0.06, y: c + s * 0.12))
    ctx.addLine(to: CGPoint(x: c - s * 0.06, y: c - s * 0.10))
    ctx.addLine(to: CGPoint(x: c - s * 0.005, y: c - s * 0.04))
    ctx.addLine(to: CGPoint(x: c + s * 0.03, y: c - s * 0.075))
    ctx.addLine(to: CGPoint(x: c + s * 0.065, y: c - s * 0.055))
    ctx.addLine(to: CGPoint(x: c + s * 0.03, y: c - s * 0.02))
    ctx.addLine(to: CGPoint(x: c + s * 0.085, y: c - s * 0.005))
    ctx.closePath(); ctx.fillPath()

    // green live dot (upper-right)
    ctx.setFillColor(NSColor(red: 0.20, green: 0.78, blue: 0.35, alpha: 1).cgColor)
    ctx.fillEllipse(in: CGRect(x: s * 0.66, y: s * 0.66, width: s * 0.12, height: s * 0.12))

    img.unlockFocus()
    let tiff = img.tiffRepresentation!
    return NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
let sizes: [(Int, String)] = [
    (16, "16x16"), (32, "16x16@2x"), (32, "32x32"), (64, "32x32@2x"),
    (128, "128x128"), (256, "128x128@2x"), (256, "256x256"), (512, "256x256@2x"),
    (512, "512x512"), (1024, "512x512@2x"),
]
for (size, name) in sizes {
    try! draw(size).write(to: URL(fileURLWithPath: "\(out)/icon_\(name).png"))
}
print("wrote \(out)")
