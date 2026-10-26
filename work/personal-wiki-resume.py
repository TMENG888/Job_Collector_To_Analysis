"""Render an evidence-selected resume PDF; never invent or fetch applicant facts."""
import sys, io, json, os
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, KeepTogether
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import A4

data=json.loads(sys.stdin.buffer.read(150000).decode('utf-8'))
font=next((p for p in ['C:/Windows/Fonts/simsun.ttc','C:/Windows/Fonts/msyh.ttc'] if os.path.isfile(p)),None)
if not font: raise ValueError('缺少可嵌入中文字体')
pdfmetrics.registerFont(TTFont('ResumeCN',font,subfontIndex=0))
body=ParagraphStyle('body',fontName='ResumeCN',fontSize=10,leading=16,textColor=HexColor('#253849'),spaceAfter=7,wordWrap='CJK')
heading=ParagraphStyle('section',parent=body,fontSize=12,leading=19,textColor=HexColor('#176b63'),spaceBefore=12,spaceAfter=8)
title=ParagraphStyle('title',parent=body,fontSize=21,leading=28,spaceAfter=8)
out=io.BytesIO();story=[]
story.append(Paragraph(escape(data.get('name') or '个人简历'),title))
story.append(Paragraph('求职意向：'+escape(data['target']),body))
for section in data['sections']:
    if not section['quotes']: continue
    paragraphs=[Paragraph(escape(section['title']),heading)]
    paragraphs.extend(Paragraph(escape(q).replace('\n','<br/>'),body) for q in section['quotes'])
    story.append(KeepTogether(paragraphs[:2]));story.extend(paragraphs[2:])
def footer(c,doc):
    c.saveState();c.setFont('ResumeCN',8);c.setFillColor(HexColor('#7b8a93'));c.drawRightString(A4[0]-44,27,str(doc.page));c.restoreState()
SimpleDocTemplate(out,pagesize=A4,leftMargin=44,rightMargin=44,topMargin=35,bottomMargin=40,title='个人简历',author='',pageCompression=1).build(story,onFirstPage=footer,onLaterPages=footer)
sys.stdout.buffer.write(out.getvalue())
