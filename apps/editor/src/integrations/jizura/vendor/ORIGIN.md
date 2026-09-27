# JIZURA vendored rendering subset

Source: https://github.com/852wa/JIZURA, commit `8da975f` (v0.9.0), MIT.
The adjacent LICENSE is retained verbatim. engine.js concatenates upstream
01_util, 02_fonts, 02b_lang, 03_text, 04_styles, 05_anim, 05b_registry,
06_layouts, 07_decor, 08_planner, 09_render and 11p_kinetic1/2/3.

Local changes: module-private `J` instead of window.J; default ESM export;
Renderer accepts a seed, grain uses a seeded stream, and paper uses a stream
derived from seed and dimensions. No global Math.random override. No upstream
UI, audio loader, exporter, or arbitrary preset-selection API is shipped.

The adapter never calls the upstream font downloader. It uses locally available
Microsoft YaHei / Yu Gothic / Arial (sans), SimSun / Yu Mincho (serif), and
Consolas (mono), with platform generic fallbacks. Same machine gives stable
glyphs; cross-machine pixel identity requires installing identical fonts.
