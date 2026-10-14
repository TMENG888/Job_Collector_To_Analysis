import io
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

def extract(data, kind):
    if kind == 'pdf':
        if not data.startswith(b'%PDF-'):
            raise ValueError('PDF格式无效，请使用文字版PDF或粘贴正文')
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise ValueError('PDF已加密，请先解除密码或粘贴正文')
        if len(reader.pages) > 40:
            raise ValueError('PDF不能超过40页，请精简简历')
        parts = []
        total = 0
        for page in reader.pages:
            text = page.extract_text() or ''
            total += len(text)
            if total > 40000:
                raise ValueError('简历正文不能超过40000字')
            parts.append(text)
        return '\n'.join(parts)
    if kind == 'docx':
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 500 or sum(entry.file_size for entry in entries) > 20 * 1024 * 1024:
                raise ValueError('DOCX解压内容过大，请精简文件')
            document = archive.getinfo('word/document.xml')
            if document.file_size > 2 * 1024 * 1024:
                raise ValueError('DOCX正文过大，请精简文件')
            xml = archive.read(document)
            if b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper():
                raise ValueError('DOCX包含不支持的XML声明，请重新保存文件')
            root = ET.fromstring(xml)
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            return '\n'.join(''.join(node.text or '' for node in para.findall('.//w:t', ns)) for para in root.findall('.//w:p', ns))
    raise ValueError('文件格式不支持')

try:
    sys.stdout.reconfigure(encoding='utf-8')
    data = sys.stdin.buffer.read(3 * 1024 * 1024 + 1)
    if len(data) > 3 * 1024 * 1024:
        raise ValueError('附件不能超过3MB')
    text = extract(data, sys.argv[1])
    if len(text) > 40000:
        raise ValueError('简历正文不能超过40000字')
    print(json.dumps({'text': text}, ensure_ascii=True))
except Exception as error:
    # Only our fixed validation messages are returned, never third-party diagnostics.
    message = str(error) if isinstance(error, ValueError) and str(error).startswith(('PDF', 'DOCX', '简历', '附件')) else '附件解析失败，请检查格式或直接粘贴正文'
    print(json.dumps({'error': message}, ensure_ascii=True))
