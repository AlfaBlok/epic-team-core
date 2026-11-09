# Fonts

Latin-subset woff2 files from Fontsource (cdn.jsdelivr.net/fontsource), all under the SIL Open Font License 1.1, which allows bundling and embedding: Inter, Inter Tight, Space Grotesk, Manrope, Fraunces, Instrument Sans, Kalam. `house_diagram.py` embeds them as data URLs in each diagram's HTML, so a render needs no network and no system fonts. File name: `<family>-<weight>.woff2`.

The paper style (the house default) does not use these: it embeds Newsreader and Instrument Sans from the shared paper brand file's `fonts` list (`skills/brands/paper.json`, files in `skills/paper-deck/assets/fonts`). The others stay for the trial styles. The licence text is in [OFL-1.1.txt](OFL-1.1.txt).
