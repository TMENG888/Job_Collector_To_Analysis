"""Render original PDF pages in memory; no reflow, OCR, network, or original file writes."""
import sys, io, json, base64, hashlib
import pypdfium2 as pdfium

try:
    data = sys.stdin.buffer.read(3 * 1024 * 1024 + 1)
    if len(data) > 3 * 1024 * 1024 or not data.startswith(b'%PDF-'):
        raise ValueError('需要3MB以内的原版式PDF')
    doc = pdfium.PdfDocument(data)
    if not 1 <= len(doc) <= 6:
        raise ValueError('截图发送仅支持1–6页完整简历，请提供精简PDF；不会截取部分页面')
    pages = []
    total = 0
    for n in range(len(doc)):
        page = doc[n]
        width, height = page.get_size()
        if min(width, height) <= 0 or max(width, height) > 14400:
            raise ValueError('PDF页面尺寸异常')
        bitmap = page.render(scale=min(2, 1800 / max(width, height)))
        image = bitmap.to_pil().convert('RGB')
        output = io.BytesIO()
        image.save(output, format='JPEG', quality=90)
        raw = output.getvalue()
        total += len(raw)
        if total > 6 * 1024 * 1024:
            raise ValueError('完整截图超过6MB，请精简原始PDF')
        pages.append(dict(page=n+1, width=image.width, height=image.height,
                          sha256=hashlib.sha256(raw).hexdigest(),
                          base64=base64.b64encode(raw).decode('ascii'), mime='image/jpeg'))
        image.close()
        bitmap.close()
        page.close()
    doc.close()
    print(json.dumps(dict(pages=pages)))
except Exception as error:
    print(json.dumps(dict(error=str(error)), ensure_ascii=True))
    sys.exit(1)
