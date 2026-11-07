// recto: a sorted table rather than a phf map; see `by_name` in mod.rs.
// See <https://github.com/apache/pdfbox/blob/4438b8fdc67a3a9ebfb194595d0e81f88b708a37/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/font/encoding/MacOSRomanEncoding.java.java>

pub(crate) fn get(code: u8) -> Option<&'static str> {
    static CODES: super::Codes = super::Codes::new();
    CODES.get(MAC_OS_ROMAN, code)
}

pub(crate) fn get_inverse(name: &str) -> Option<u8> {
    super::by_name(MAC_OS_ROMAN_INVERSE, name).and_then(super::number).map(|code| code as u8)
}

pub(super) static MAC_OS_ROMAN: &[u8] = b"\
    AD\xFEnotequal\xFF\
    B0\xFEinfinity\xFF\
    B2\xFElessequal\xFF\
    B3\xFEgreaterequal\xFF\
    B6\xFEpartialdiff\xFF\
    B7\xFEsummation\xFF\
    B8\xFEproduct\xFF\
    B9\xFEpi\xFF\
    BA\xFEintegral\xFF\
    BD\xFEOmega\xFF\
    C3\xFEradical\xFF\
    C5\xFEapproxequal\xFF\
    C6\xFEDelta\xFF\
    D7\xFElozenge\xFF\
    DB\xFEEuro\xFF\
    F0\xFEapple\xFF";

pub(super) static MAC_OS_ROMAN_INVERSE: &[u8] = b"\
    Delta\xFE198\xFF\
    Euro\xFE219\xFF\
    Omega\xFE189\xFF\
    apple\xFE240\xFF\
    approxequal\xFE197\xFF\
    greaterequal\xFE179\xFF\
    infinity\xFE176\xFF\
    integral\xFE186\xFF\
    lessequal\xFE178\xFF\
    lozenge\xFE215\xFF\
    notequal\xFE173\xFF\
    partialdiff\xFE182\xFF\
    pi\xFE185\xFF\
    product\xFE184\xFF\
    radical\xFE195\xFF\
    summation\xFE183\xFF";
