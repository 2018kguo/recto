use crate::context::Context;
use crate::device::Device;
use crate::font::{Glyph, GlyphRun, PositionedGlyph, UNITS_PER_EM, get_glyph};
use crate::interpret::state::TextStateFont;
use crate::{DrawMode, FillRule};
use hayro_cmap::WritingMode;
use hayro_syntax::page::Resources;
use kurbo::{Affine, BezPath};

pub(crate) fn show_text_string<'a>(
    ctx: &mut Context<'a>,
    device: &mut impl Device<'a>,
    resources: &Resources<'a>,
    text: &[u8],
) {
    begin_glyph_run(ctx);
    append_text_string(ctx, resources, text);
    show_glyph_run(ctx, device);
}

pub(crate) fn begin_glyph_run(ctx: &mut Context<'_>) {
    ctx.glyph_scratch.clear();
}

pub(crate) fn append_text_string<'a>(
    ctx: &mut Context<'a>,
    resources: &Resources<'a>,
    bytes: &[u8],
) {
    let Some(font) = ctx.text_state().font.clone() else {
        return;
    };

    // In case we have a fallback font (which occurs if either no font was set at all
    // in the content stream, or an invalid one), we only want to show the glyphs
    // using Helvetica if the bytes are actually valid ASCII.
    let show_glyphs = matches!(font, TextStateFont::Font(_))
        || (matches!(font, TextStateFont::Fallback(_)) && bytes.is_ascii());

    let mut cur_idx = 0;
    while cur_idx < bytes.len() {
        let (code, adv) = font.read_code(bytes, cur_idx);
        cur_idx += adv;

        // recto: one code-table read for the glyph, its placement and advance.
        let metrics = font.code_metrics(code);
        if show_glyphs && ctx.ocg_state.is_visible() {
            let transform = ctx.text_state().full_transform()
                * Affine::scale(1.0 / UNITS_PER_EM as f64)
                * Affine::translate(metrics.displacement)
                * Affine::scale_non_uniform(metrics.stretch, 1.0);
            let glyph = get_glyph(&font, metrics.glyph, code, ctx, resources);

            let state = ctx.text_state();
            // Over `stretch`: the transform that scales this back carries it.
            let char_space = if state.font_size == 0.0 || metrics.stretch == 0.0 {
                0.0
            } else {
                state.char_space / state.font_size * UNITS_PER_EM / metrics.stretch as f32
            };
            ctx.glyph_scratch.push(PositionedGlyph {
                glyph,
                transform,
                char_space,
                font_size: state.font_size,
                stretch: metrics.stretch as f32,
                h_scale: state.horizontal_scaling / 100.0,
            });
        }

        ctx.text_state_mut()
            .apply_advance(code, adv, metrics.advance);
    }
}

pub(crate) fn apply_glyph_run_adjustment(ctx: &mut Context<'_>, adjustment: f32) {
    ctx.text_state_mut().apply_adjustment(adjustment);
}

pub(crate) fn next_line(ctx: &mut Context<'_>, tx: f64, ty: f64) {
    let new_matrix = ctx.text_state_mut().text_line_matrix * Affine::translate((tx, ty));
    ctx.text_state_mut().text_line_matrix = new_matrix;
    ctx.text_state_mut().text_matrix = new_matrix;
}

pub(crate) fn show_glyph_run<'a>(ctx: &mut Context<'a>, device: &mut impl Device<'a>) {
    if ctx.glyph_scratch.is_empty() {
        return;
    }

    let render_mode = ctx.text_state().render_mode;
    // recto: build only the props this mode draws with. Plain fill text (nearly
    // all of it) skips the stroke paint and props, about half the per-run cost.
    let strokes = matches!(
        render_mode,
        TextRenderingMode::Stroke
            | TextRenderingMode::FillStroke
            | TextRenderingMode::StrokeAndClip
            | TextRenderingMode::FillAndStrokeAndClip
    );
    let fills = !matches!(
        render_mode,
        TextRenderingMode::Stroke | TextRenderingMode::StrokeAndClip
    );
    let fill_props = fills.then(|| ctx.draw_props(false));
    let stroke = strokes.then(|| (ctx.stroke_props().clone(), ctx.draw_props(true)));

    let writing_mode = if ctx.text_state().font_horizontal() {
        WritingMode::Horizontal
    } else {
        WritingMode::Vertical
    };

    let clip_path = {
        let run = GlyphRun {
            glyphs: &ctx.glyph_scratch,
            writing_mode,
            repeats_fill: false,
        };

        let clip_path = if matches!(
            render_mode,
            TextRenderingMode::Clip
                | TextRenderingMode::FillAndClip
                | TextRenderingMode::StrokeAndClip
                | TextRenderingMode::FillAndStrokeAndClip
        ) {
            let mut clip_path = BezPath::new();
            for glyph in run.glyphs() {
                clip_glyph(&mut clip_path, glyph);
            }
            Some(clip_path)
        } else {
            None
        };

        let fill = DrawMode::Fill(FillRule::NonZero);
        match render_mode {
            TextRenderingMode::Fill | TextRenderingMode::FillAndClip => {
                if let Some(props) = fill_props {
                    device.draw_glyph_run(&run, props, &fill);
                }
            }
            TextRenderingMode::Stroke | TextRenderingMode::StrokeAndClip => {
                if let Some((stroke_props, props)) = stroke {
                    device.draw_glyph_run(&run, props, &DrawMode::Stroke(stroke_props));
                }
            }
            TextRenderingMode::FillStroke | TextRenderingMode::FillAndStrokeAndClip => {
                let fill_props_drawn = fill_props.is_some();
                if let Some(props) = fill_props {
                    device.draw_glyph_run(&run, props, &fill);
                }
                if let Some((stroke_props, props)) = stroke {
                    let again = GlyphRun {
                        repeats_fill: fill_props_drawn,
                        ..run
                    };
                    device.draw_glyph_run(&again, props, &DrawMode::Stroke(stroke_props));
                }
            }
            // Still drawn for invisible text, so that it can for example be
            // used for text extraction. TODO (upstream): pass clipping-only
            // text with its own draw mode.
            TextRenderingMode::Invisible | TextRenderingMode::Clip => {
                if let Some(props) = fill_props {
                    device.draw_glyph_run(&run, props, &DrawMode::Invisible);
                }
            }
        }

        clip_path
    };

    if let Some(clip_path) = clip_path {
        ctx.text_state_mut().clip_paths.extend(clip_path);
    }

    ctx.glyph_scratch.clear();
}

fn clip_glyph(clip_path: &mut BezPath, glyph: &PositionedGlyph<'_>) {
    match &**glyph {
        Glyph::Outline(outline_glyph) => {
            let outline = glyph.transform() * outline_glyph.outline();
            let has_outline = outline.segments().next().is_some();

            if has_outline {
                clip_path.extend(outline);
            }
        }
        Glyph::Type3(_) => {}
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) enum TextRenderingMode {
    #[default]
    Fill,
    Stroke,
    FillStroke,
    Invisible,
    FillAndClip,
    StrokeAndClip,
    FillAndStrokeAndClip,
    Clip,
}
