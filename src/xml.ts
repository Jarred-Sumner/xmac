/**
 * Minimal XML parser + Apple property-list reader.
 *
 * Non-validating; handles the subset of XML that Apple's plists, xar TOCs and
 * .dist files use: elements, attributes, text, CDATA, comments, doctype,
 * processing instructions and the five predefined entities + numeric refs.
 */

import { XmacError } from "./util";

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (ent) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return m;
    }
  });
}

export function parseXml(input: string): XmlNode {
  let i = 0;
  const n = input.length;
  const root: XmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];

  const top = () => stack[stack.length - 1];

  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      top().text += decodeEntities(input.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(input.slice(i, lt));
    i = lt;

    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4);
      if (end === -1) throw new XmacError("xml: unterminated comment");
      i = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", i)) {
      const end = input.indexOf("]]>", i + 9);
      if (end === -1) throw new XmacError("xml: unterminated CDATA");
      top().text += input.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (input.startsWith("<!", i) || input.startsWith("<?", i)) {
      // DOCTYPE / processing instruction — skip to the matching '>'.
      // DOCTYPEs may contain an internal subset in [...]; Apple's don't.
      const end = input.indexOf(">", i);
      if (end === -1) throw new XmacError("xml: unterminated declaration");
      i = end + 1;
      continue;
    }
    if (input.startsWith("</", i)) {
      const end = input.indexOf(">", i);
      if (end === -1) throw new XmacError("xml: unterminated close tag");
      const name = input.slice(i + 2, end).trim();
      if (stack.length < 2 || top().tag !== name)
        throw new XmacError(`xml: mismatched close tag </${name}> (open: <${top().tag}>)`);
      stack.pop();
      i = end + 1;
      continue;
    }

    // Open tag
    const end = input.indexOf(">", i);
    if (end === -1) throw new XmacError("xml: unterminated open tag");
    let tagBody = input.slice(i + 1, end);
    i = end + 1;
    let selfClose = false;
    if (tagBody.endsWith("/")) {
      selfClose = true;
      tagBody = tagBody.slice(0, -1);
    }
    const m = /^([^\s]+)\s*/.exec(tagBody);
    if (!m) throw new XmacError("xml: empty tag");
    const node: XmlNode = { tag: m[1], attrs: {}, children: [], text: "" };
    const rest = tagBody.slice(m[0].length);
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')\s*/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(rest)) !== null) {
      node.attrs[am[1]] = decodeEntities(am[3] ?? am[4] ?? "");
    }
    top().children.push(node);
    if (!selfClose) stack.push(node);
  }
  if (stack.length !== 1) throw new XmacError(`xml: unclosed element <${top().tag}>`);
  return root;
}

export function firstChild(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((co) => co.tag === tag);
}

export function childText(node: XmlNode, tag: string): string | undefined {
  const co = firstChild(node, tag);
  return co ? co.text.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Apple property list (XML plist) → JS values
// ---------------------------------------------------------------------------

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | PlistValue[]
  | { [k: string]: PlistValue };

function plistToJs(node: XmlNode): PlistValue {
  switch (node.tag) {
    case "dict": {
      const out: Record<string, PlistValue> = {};
      const kids = node.children;
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].tag !== "key") continue;
        const key = kids[i].text;
        const val = kids[i + 1];
        if (!val) break;
        out[key] = plistToJs(val);
        i++;
      }
      return out;
    }
    case "array":
      return node.children.map(plistToJs);
    case "string":
      return node.text;
    case "integer":
      return parseInt(node.text.trim(), 10);
    case "real":
      return parseFloat(node.text.trim());
    case "date":
      return new Date(node.text.trim());
    case "true":
      return true;
    case "false":
      return false;
    case "data":
      return Uint8Array.from(atob(node.text.replace(/\s+/g, "")), (ch) => ch.charCodeAt(0));
    default:
      throw new XmacError(`plist: unexpected element <${node.tag}>`);
  }
}

export function parsePlist(xml: string): PlistValue {
  const root = parseXml(xml);
  const plist = firstChild(root, "plist");
  if (!plist || plist.children.length === 0) throw new XmacError("plist: missing <plist> root");
  return plistToJs(plist.children[0]);
}
