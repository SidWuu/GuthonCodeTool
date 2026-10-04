"""Dependency-free XLSX export of bounded query rows and explicit evidence.

String values are inline text, never formulas. Large integers remain text so
spreadsheet numeric precision cannot silently change a business identifier.
"""
from __future__ import annotations

import io
import json
import math
import re
import zipfile
from xml.etree.ElementTree import Element, SubElement, tostring

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'


def _column(index):
    name=''
    while index:
        index, remainder=divmod(index-1,26);name=chr(65+remainder)+name
    return name


def _sheet(rows):
    sheet=Element('worksheet',xmlns=NS);data=SubElement(sheet,'sheetData')
    for row_number,values in enumerate(rows,1):
        row=SubElement(data,'row',r=str(row_number))
        for column_number,value in enumerate(values,1):
            if value is None:continue
            cell=SubElement(row,'c',r=_column(column_number)+str(row_number))
            if isinstance(value,bool):
                cell.set('t','b');SubElement(cell,'v').text='1' if value else '0'
            elif isinstance(value,int) and len(str(abs(value)))<=15:
                cell.set('t','n');SubElement(cell,'v').text=str(value)
            elif isinstance(value,float) and math.isfinite(value):
                cell.set('t','n');SubElement(cell,'v').text=repr(value)
            else:
                text=str(value)
                if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]',text):
                    raise ValueError('XLSX cell contains an unsupported XML character; use JSON to retain the original value')
                if len(text)>32767:raise ValueError('XLSX cell exceeds its text limit; use JSON or a narrower query')
                cell.set('t','inlineStr');inline=SubElement(cell,'is')
                SubElement(inline,'t',{'{http://www.w3.org/XML/1998/namespace}space':'preserve'}).text=text
    return tostring(sheet,encoding='utf-8',xml_declaration=True)


def workbook(payload, result):
    if not isinstance(result,dict) or not {'columns','rows','truncation'}.issubset(result):
        raise ValueError('XLSX requires an executed query result with explicit completeness, not a probe or DBX handoff')
    if result['truncation'] not in {'none','rows','cell','unknown'}:
        raise ValueError('XLSX result completeness is invalid')
    columns=result.get('columns',[]);rows=result.get('rows',[])
    if not isinstance(columns,list) or not isinstance(rows,list) or not all(isinstance(name,str) for name in columns):
        raise ValueError('XLSX requires structured query columns and rows')
    if len(columns)>16384 or len(rows)>100:raise ValueError('XLSX export accepts at most 100 rows and 16384 columns')
    values=[columns]
    for row in rows:
        if not isinstance(row,dict):raise ValueError('XLSX query rows must be objects')
        values.append([row.get(name) for name in columns])
    evidence=[['key','value']]
    for key in ['workspaceKey','targetId','selectionSource','connector','targetDigest']:
        if key in payload:evidence.append([key,payload[key]])
    target=payload.get('target',{})
    if isinstance(target,dict):
        for key in ['id','environment','database','schema']:
            if key in target:evidence.append(['target.'+key,target[key]])
    for key in ['maxRows','truncation','truncationDetails','kind','queryExecuted','analyze','evidenceBoundary']:
        if key in result:
            value=result[key];evidence.append([key,json.dumps(value,ensure_ascii=False) if isinstance(value,(dict,list)) else value])
    evidence.extend([['rowCountReturned',len(rows)],['evidenceBoundary','Bounded database query only; no platform-version or business-flow proof; strings are never formulas']])
    types=Element('Types',xmlns='http://schemas.openxmlformats.org/package/2006/content-types')
    for ext,content in [('rels','application/vnd.openxmlformats-package.relationships+xml'),('xml','application/xml')]:SubElement(types,'Default',Extension=ext,ContentType=content)
    for part,content in [('/xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'),('/xl/worksheets/sheet1.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'),('/xl/worksheets/sheet2.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')]:SubElement(types,'Override',PartName=part,ContentType=content)
    root_rels=Element('Relationships',xmlns=REL);SubElement(root_rels,'Relationship',Id='rId1',Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',Target='xl/workbook.xml')
    book=Element('workbook',xmlns=NS);sheets=SubElement(book,'sheets')
    relationships=Element('Relationships',xmlns=REL)
    for number,name in [(1,'结果'),(2,'证据')]:
        SubElement(sheets,'sheet',{'name':name,'sheetId':str(number),'{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id':'rId'+str(number)})
        SubElement(relationships,'Relationship',Id='rId'+str(number),Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',Target='worksheets/sheet'+str(number)+'.xml')
    output=io.BytesIO()
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        for name,node in [('[Content_Types].xml',types),('_rels/.rels',root_rels),('xl/workbook.xml',book),('xl/_rels/workbook.xml.rels',relationships)]:archive.writestr(name,tostring(node,encoding='utf-8',xml_declaration=True))
        archive.writestr('xl/worksheets/sheet1.xml',_sheet(values));archive.writestr('xl/worksheets/sheet2.xml',_sheet(evidence))
    return output.getvalue()
