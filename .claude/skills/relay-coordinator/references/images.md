# Images - reading a thread entry's file off disk

Read when: you need to open an image that came back on a thread entry.

- Thread entries hand back a `path` already translated to the HOST filesystem (`data/host.json`/`HOST_DATA_DIR` mapping applied on read) — read that path directly with your file tool. Don't fetch `url`, that's the browser's route.
- A `path` starting `/app/` means the host mapping is missing; the real file is at `data/images/<sha>` under the repo.

---

Back to the core manual: `SKILL.md`.
