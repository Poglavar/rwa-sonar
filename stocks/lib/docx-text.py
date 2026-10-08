#!/usr/bin/env python3
"""Read visible DOCX text in memory, including tables, notes and headers; never extract files."""
import io
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_INPUT = 24 * 1024 * 1024
MAX_XML = 16 * 1024 * 1024
WORD_NAMESPACES = {
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
}
DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
PARTS = re.compile(r"word/(document|footnotes|endnotes|header[0-9]+|footer[0-9]+)\.xml$")


def visible_text(node):
    namespace, _, tag = node.tag.lstrip("{").partition("}")
    if namespace not in WORD_NAMESPACES:
        return "".join(visible_text(child) for child in node)
    # Read the accepted view; deleted text and moved-away text must not survive as current terms.
    if tag in ("del", "moveFrom"):
        return ""
    if tag == "t":
        return node.text or ""
    if tag == "tab":
        return "\t"
    if tag in ("br", "cr"):
        return "\n"
    text = "".join(visible_text(child) for child in node)
    return text + ("\n" if tag in ("p", "tr") else "\t" if tag == "tc" else "")


def extract(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 4096:
            raise ValueError("too many DOCX archive entries")
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("duplicate DOCX archive entries")
        if "word/document.xml" not in names or "[Content_Types].xml" not in names:
            raise ValueError("not a DOCX document")
        parts = ["[Content_Types].xml", "word/document.xml"] + sorted(
            name for name in names if PARTS.fullmatch(name) and name != "word/document.xml"
        )
        if sum(archive.getinfo(name).file_size for name in parts) > MAX_XML:
            raise ValueError("DOCX XML exceeds 16 MiB")
        roots = {}
        for name in parts:
            info = archive.getinfo(name)
            if info.flag_bits & 1:
                raise ValueError("encrypted DOCX content is unsupported")
            payload = archive.read(name)
            if b"<!DOCTYPE" in payload.upper() or b"<!ENTITY" in payload.upper():
                raise ValueError("DTD/entity declarations are unsupported")
            roots[name] = ET.fromstring(payload)
        types = roots.pop("[Content_Types].xml")
        if not any(node.get("PartName") == "/word/document.xml"
                   and node.get("ContentType") == DOCX_CONTENT_TYPE for node in types):
            raise ValueError("not a supported DOCX document type")
        output = []
        for name, root in roots.items():
            if name in ("word/footnotes.xml", "word/endnotes.xml"):
                # Negative/zero note IDs are separator machinery, not document prose.
                for note in root:
                    note_id = next((value for key, value in note.attrib.items() if key.endswith("}id")), "0")
                    if int(note_id) > 0:
                        output.append(visible_text(note))
            else:
                output.append(visible_text(root))
        return "\n".join(output)


if __name__ == "__main__":
    try:
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            raise ValueError("DOCX input exceeds 24 MiB")
        sys.stdout.write(extract(data))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
