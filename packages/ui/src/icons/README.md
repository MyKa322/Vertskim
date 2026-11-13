# File and folder icons

The SVG files in this folder come, unchanged, from
[vscode-icons](https://github.com/vscode-icons/vscode-icons) (commit `c5a73e0`). They are a
chosen subset: the languages Vertskim reads, plus the file and folder names a project usually has.

They are **not** covered by Vertskim's Apache 2.0 licence:

- The icons are licensed under
  [Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
  by the vscode-icons contributors.
- Icons that show a brand (a language or product logo) remain under the licence of that
  brand's owner.

`../fileIcons.ts` decides which icon a file or folder gets. To add one, copy its SVG here from
the `icons/` folder of vscode-icons, keeping the file name, and name it in that file.
