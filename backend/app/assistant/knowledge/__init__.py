"""Knowledge base for concept questions ("what is IV crush?").

Sources:
  notes/*.md                  -- concept notes kept in the repo, one chunk per "## " section
  docs/*.pdf (repo root)      -- the StockSage guides (options buyer's guide, app documentation),
                                 one or more chunks per page

Retrieval is BM25 over word tokens: no embedding model, deterministic, fast,
works offline and on a phone. search() returns the best chunks with their
source so the assistant can cite them.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
NOTES = HERE / "notes"
REPO_DOCS = HERE.parents[3] / "docs"
CHUNK_CHARS = 1200

_STOP = set("""a an the and or of to in on for is are was were be been it its this that these those with as at by
from what which who how why when do does did can could should would will i you my your we our me us if then than
so not no yes about into over under more most less very just also there their they them he she his her vs""".split())


@dataclass
class Chunk:
    id: str
    title: str
    source: str
    text: str


def _tokens(text: str) -> list[str]:
    out = []
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        if w in _STOP or len(w) < 2 and not w.isdigit():
            continue
        if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]                                   # calls -> call, options -> option
        out.append(w)
    return out


def _clean(text: str) -> str:
    return re.sub(r"[ \t]+", " ", re.sub(r"\s*\n\s*", "\n", text)).strip()


def load_notes(folder: Path = NOTES) -> list[Chunk]:
    chunks = []
    for f in sorted(folder.glob("*.md")):
        doc_title, section, buf = f.stem.replace("_", " "), None, []
        lines = f.read_text(encoding="utf-8").splitlines()

        def flush():
            body = _clean("\n".join(buf))
            if section and body:
                chunks.append(Chunk(f"{f.stem}#{len(chunks)}", section, f"note: {doc_title}", body))

        for line in lines:
            if line.startswith("# "):
                doc_title = line[2:].strip()
            elif line.startswith("## "):
                flush()
                section, buf = line[3:].strip(), []
            else:
                buf.append(line)
        flush()
    return chunks


def load_pdfs(folder: Path = REPO_DOCS) -> list[Chunk]:
    try:
        from pypdf import PdfReader
    except ImportError:
        return []
    chunks = []
    for f in sorted(folder.glob("*.pdf")) if folder.exists() else []:
        name = f.stem.replace("-", " ")
        for pno, page in enumerate(PdfReader(str(f)).pages, 1):
            text = _clean(page.extract_text() or "")
            if pno == 1 or "table of contents" in text.lower():
                continue                                   # cover and contents pages match everything
            lines = text.splitlines()
            if len(lines) > 2 and lines[0].startswith("StockSage"):
                text = "\n".join(lines[1:])                # drop the running header
            for i in range(0, len(text), CHUNK_CHARS):
                part = text[max(0, i - 150): i + CHUNK_CHARS]   # small overlap between windows
                if len(part.strip()) > 80:
                    chunks.append(Chunk(f"{f.stem}#p{pno}.{i // CHUNK_CHARS}", f"{name}, page {pno}",
                                        f"guide: {name} p.{pno}", part))
    return chunks


class BM25:
    def __init__(self, docs: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.docs, self.k1, self.b = docs, k1, b
        self.avg = sum(map(len, docs)) / max(1, len(docs))
        self.tf = [Counter(d) for d in docs]
        df = Counter(t for d in docs for t in set(d))
        n = len(docs)
        self.idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}

    def scores(self, query: list[str]) -> list[float]:
        out = []
        for d, tf in zip(self.docs, self.tf):
            s = 0.0
            for t in query:
                if t in tf:
                    f = tf[t]
                    s += self.idf[t] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * len(d) / self.avg))
            out.append(s)
        return out


class KnowledgeBase:
    def __init__(self, chunks: list[Chunk]):
        self.chunks = chunks
        # the title counts twice: section headings are the best summary of a chunk
        self.index = BM25([_tokens(c.title) * 2 + _tokens(c.text) for c in chunks])

    def search(self, query: str, k: int = 3) -> list[dict]:
        q = _tokens(query)
        if not q or not self.chunks:
            return []
        ranked = sorted(zip(self.index.scores(q), self.chunks), key=lambda x: -x[0])
        return [{"title": c.title, "source": c.source, "score": round(s, 2), "text": c.text[:CHUNK_CHARS]}
                for s, c in ranked[:k] if s > 0]


@lru_cache(maxsize=1)
def default_kb() -> KnowledgeBase:
    return KnowledgeBase(load_notes() + load_pdfs())
