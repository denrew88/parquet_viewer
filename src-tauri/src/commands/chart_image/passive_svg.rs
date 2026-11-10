//! Validate the passive XML subset emitted by the chart renderer. The document
//! is written back verbatim, so no entity expansion or URL fetching is needed.

use std::borrow::Cow;

const SVG_NS: &str = "http://www.w3.org/2000/svg";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";
const MAX_DEPTH: usize = 64;

pub(super) fn closing_tag(document: &str) -> Option<usize> {
    let mut rest = document;
    let mut stack = Vec::new();
    while let Some(open) = rest.find('<') {
        let text = &rest[..open];
        if (stack.is_empty() && !text.trim_matches(xml_space).is_empty()) || !xml_text(text) {
            return None;
        }
        rest = &rest[open..];
        let offset = document.len() - rest.len();
        if let Some(after_open) = rest.strip_prefix("</") {
            let (tag, after_name) = name(after_open)?;
            rest = after_name.trim_start_matches(xml_space).strip_prefix('>')?;
            if stack.pop()? != tag {
                return None;
            }
            if stack.is_empty() {
                return rest.trim_matches(xml_space).is_empty().then_some(offset);
            }
            continue;
        }

        let (tag, after_name) = name(rest.strip_prefix('<')?)?;
        let is_root = stack.is_empty();
        if (is_root && tag != "svg") || !allowed_element(tag) || stack.len() >= MAX_DEPTH {
            return None;
        }
        let (empty, has_namespace, after_tag) = attributes(after_name)?;
        if is_root && (empty || !has_namespace) {
            return None;
        }
        if !empty {
            stack.push(tag);
        }
        rest = after_tag;
    }
    None
}

fn allowed_element(tag: &str) -> bool {
    matches!(
        tag,
        "svg"
            | "g"
            | "path"
            | "rect"
            | "circle"
            | "ellipse"
            | "line"
            | "polyline"
            | "polygon"
            | "text"
            | "tspan"
            | "defs"
            | "clipPath"
            | "linearGradient"
            | "radialGradient"
            | "stop"
            | "title"
            | "desc"
    )
}

fn name(source: &str) -> Option<(&str, &str)> {
    if !source.as_bytes().first()?.is_ascii_alphabetic() {
        return None;
    }
    let length = source
        .bytes()
        .take_while(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.')
        })
        .count();
    Some(source.split_at(length))
}

fn attributes(mut rest: &str) -> Option<(bool, bool, &str)> {
    let mut seen = Vec::new();
    loop {
        let before_space = rest.len();
        rest = rest.trim_start_matches(xml_space);
        if let Some(after_tag) = rest.strip_prefix("/>") {
            return Some((true, seen.contains(&"xmlns"), after_tag));
        }
        if let Some(after_tag) = rest.strip_prefix('>') {
            return Some((false, seen.contains(&"xmlns"), after_tag));
        }
        if before_space == rest.len() {
            return None;
        }
        let (attr, after_name) = name(rest)?;
        if seen.contains(&attr) {
            return None;
        }
        let quoted = after_name
            .trim_start_matches(xml_space)
            .strip_prefix('=')?
            .trim_start_matches(xml_space);
        let quote = match quoted.as_bytes().first()? {
            b'\'' => '\'',
            b'"' => '"',
            _ => return None,
        };
        let (value, after_value) = quoted[1..].split_once(quote)?;
        if !xml_text(value) || !allowed_attribute(attr, value) {
            return None;
        }
        seen.push(attr);
        rest = after_value;
    }
}

fn allowed_attribute(name: &str, value: &str) -> bool {
    match name {
        "xmlns" => value == SVG_NS,
        "xmlns:xlink" => value == XLINK_NS,
        "xml:space" => matches!(value, "default" | "preserve"),
        "clip-path" => value == "none" || local_reference(value),
        "fill" | "stroke" | "stop-color" | "color" => paint(value),
        "style" => font_style(value),
        name if font_property(name) => font_value(value),
        "id" => value != "dv-chart-export-points-clip",
        "class"
        | "width"
        | "height"
        | "x"
        | "y"
        | "dx"
        | "dy"
        | "x1"
        | "y1"
        | "x2"
        | "y2"
        | "cx"
        | "cy"
        | "fx"
        | "fy"
        | "r"
        | "rx"
        | "ry"
        | "viewBox"
        | "preserveAspectRatio"
        | "version"
        | "baseProfile"
        | "d"
        | "points"
        | "transform"
        | "opacity"
        | "fill-opacity"
        | "stroke-opacity"
        | "stroke-width"
        | "stroke-linecap"
        | "stroke-linejoin"
        | "stroke-miterlimit"
        | "stroke-dasharray"
        | "stroke-dashoffset"
        | "fill-rule"
        | "clip-rule"
        | "clipPathUnits"
        | "gradientUnits"
        | "gradientTransform"
        | "offset"
        | "stop-opacity"
        | "text-anchor"
        | "dominant-baseline"
        | "alignment-baseline"
        | "pointer-events"
        | "paint-order"
        | "vector-effect"
        | "shape-rendering"
        | "text-rendering"
        | "role"
        | "aria-label"
        | "aria-hidden"
        | "ecmeta_series_index"
        | "ecmeta_data_index"
        | "ecmeta_ssr_type"
        | "ecmeta_silent" => true,
        _ => false,
    }
}

fn local_reference(value: &str) -> bool {
    value
        .strip_prefix("url(#")
        .and_then(|value| value.strip_suffix(')'))
        .is_some_and(|id| {
            !id.is_empty()
                && id.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
                })
        })
}

fn paint(value: &str) -> bool {
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8)
            && hex.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    if let Some(channels) = value
        .strip_prefix("rgb(")
        .or_else(|| value.strip_prefix("rgba("))
    {
        return channels.strip_suffix(')').is_some_and(|channels| {
            !channels.is_empty()
                && channels.bytes().all(|byte| {
                    byte.is_ascii_digit() || matches!(byte, b'.' | b',' | b' ' | b'%' | b'-' | b'+')
                })
        });
    }
    local_reference(value)
        || (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphabetic()))
}

fn font_property(name: &str) -> bool {
    matches!(
        name,
        "font"
            | "font-size"
            | "font-family"
            | "font-weight"
            | "font-style"
            | "font-variant"
            | "font-stretch"
    )
}

fn font_style(value: &str) -> bool {
    let value = if value.contains('&') {
        Cow::Owned(value.replace("&quot;", "\"").replace("&apos;", "'"))
    } else {
        Cow::Borrowed(value)
    };
    value
        .split(';')
        .filter(|declaration| !declaration.trim_ascii().is_empty())
        .all(|declaration| {
            declaration.split_once(':').is_some_and(|(name, value)| {
                font_property(name.trim_ascii()) && font_value(value.trim_ascii())
            })
        })
}

fn font_value(value: &str) -> bool {
    let mut rest = value;
    loop {
        let (plain, encoded) = rest.split_once('&').unwrap_or((rest, ""));
        if !plain.chars().all(|c| {
            c.is_alphanumeric()
                || matches!(
                    c,
                    ' ' | '\t' | '-' | '_' | ',' | '.' | '%' | '/' | '"' | '\''
                )
        }) {
            return false;
        }
        if encoded.is_empty() {
            return true;
        }
        let Some(after_quote) = encoded
            .strip_prefix("quot;")
            .or_else(|| encoded.strip_prefix("apos;"))
        else {
            return false;
        };
        rest = after_quote;
    }
}

fn xml_character(character: char) -> bool {
    matches!(character, '\t' | '\r' | '\n' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')
}

fn xml_space(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\r' | '\n')
}

fn xml_text(text: &str) -> bool {
    if text.contains('<') || text.contains("]]>") || !text.chars().all(xml_character) {
        return false;
    }
    let mut remainder = text;
    while let Some((_, encoded)) = remainder.split_once('&') {
        let Some((entity, rest)) = encoded.split_once(';') else {
            return false;
        };
        if !matches!(entity, "amp" | "lt" | "gt" | "quot" | "apos") {
            let codepoint = if let Some(hex) = entity.strip_prefix("#x") {
                hex.bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                    .then(|| u32::from_str_radix(hex, 16).ok())
                    .flatten()
            } else if let Some(decimal) = entity.strip_prefix('#') {
                decimal
                    .bytes()
                    .all(|byte| byte.is_ascii_digit())
                    .then(|| decimal.parse::<u32>().ok())
                    .flatten()
            } else {
                None
            };
            if !codepoint
                .and_then(char::from_u32)
                .is_some_and(xml_character)
            {
                return false;
            }
        }
        remainder = rest;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svg(body: &str) -> String {
        format!(r#"<svg xmlns="{SVG_NS}" viewBox="0 0 400 200">{body}</svg>"#)
    }

    #[test]
    fn accepts_rendered_vectors_escaped_text_and_local_clips() {
        let document = svg(
            r##"<defs><clipPath id="axes"><rect width="400" height="200"/></clipPath></defs>
<g clip-path="url(#axes)" transform="translate(0 32)">
<path d="M1 2L3 4" fill="#087f78" fill-opacity="0.64" ecmeta_data_index="5"></path>
<text style="font-size:12px;font-family:Microsoft YaHei;" xml:space="preserve">한글 &amp; &lt;script&gt; &#x27;</text></g>"##,
        );
        let closing = closing_tag(&document).unwrap();
        assert_eq!(&document[closing..], "</svg>");
    }

    #[test]
    fn rejects_active_links_executable_elements_and_invalid_xml() {
        for content in [
            r#"<script>alert(1)</script>"#,
            r#"<image href="https://example.invalid/a.png"/>"#,
            r#"<path onload="alert(1)"/>"#,
            r#"<foreignObject/>"#,
            r#"<animate attributeName="x"/>"#,
            r#"<style>@import "unsafe";</style>"#,
            r#"<text style="font-family:url(https://example.invalid)"/>"#,
            r#"<text style="font-size:12px;fill:red"/>"#,
            r#"<path fill="url(https://example.invalid)"/>"#,
            r#"<path clip-path="url(&#x23;unsafe)"/>"#,
            r#"<g xmlns="http://www.w3.org/1999/xhtml"/>"#,
            r#"<g xml:base="https://example.invalid"/>"#,
            r#"<g>broken & unknown</g>"#,
            r#"<g>&#0;</g>"#,
            r#"<g>&#x110000;</g>"#,
            r#"<g class="a"class="b"/>"#,
            r#"<g><text></g></text>"#,
            r#"<g></g><!DOCTYPE svg>"#,
        ] {
            assert_eq!(closing_tag(&svg(content)), None, "{content}");
        }
        assert_eq!(closing_tag("<svg></svg>"), None);
        assert_eq!(closing_tag(&format!("{}<g/>", svg(""))), None);
        assert_eq!(closing_tag(&svg(&"<g>".repeat(64))), None);
    }
}
