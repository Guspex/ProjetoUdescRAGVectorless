#!/usr/bin/env python3
"""
Baixa todas as Instruções Normativas (e anexos/fluxogramas) da página da UDESC.

Estrutura de saída:
    instrucoes_normativas_udesc/
        2026/
            IN_001_2026/
                Processo_UDESC_....pdf
                IN_001_2026_Anexos_....docx
        2025/
            IN_001_2025_PROAD/
        ...
        manifesto.csv   (ano, IN, tipo, descrição, url, arquivo, status)

Uso:
    pip install requests beautifulsoup4
    python baixar_ins_udesc.py
    python baixar_ins_udesc.py --saida minha_pasta --url https://www.udesc.br/proreitoria/proplan/normativos/instrucoesrevogadas
"""

import argparse
import csv
import re
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote

import requests
from bs4 import BeautifulSoup, Tag

URL_PADRAO = "https://www.udesc.br/proreitoria/proplan/normativos/instru%C3%A7%C3%B5esnormativas"
EXTENSOES = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".odt", ".ods", ".png", ".jpg", ".jpeg", ".zip"}
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; baixador-IN-udesc/1.0)"}

RE_ANO = re.compile(r"^\s*((?:19|20)\d{2})\b")
RE_IN = re.compile(
    r"(\d{3})\s*/\s*(\d{4})\s*[-–]?\s*"
    r"([A-Z]{2,}(?:/[A-Z]+)*(?:\s+e\s+[A-Z]{2,})?)?"
)


def texto_proprio(li: Tag) -> str:
    """Texto do <li> sem incluir as sub-listas (<ul>/<ol>) aninhadas."""
    partes = []
    for filho in li.children:
        if isinstance(filho, Tag) and filho.name in ("ul", "ol"):
            continue
        partes.append(filho.get_text(" ", strip=True) if isinstance(filho, Tag) else str(filho))
    return re.sub(r"\s+", " ", " ".join(partes)).replace("\u200b", "").strip()


def slug(texto: str) -> str:
    texto = re.sub(r"[^\w\-]+", "_", texto, flags=re.UNICODE)
    return re.sub(r"_+", "_", texto).strip("_") or "sem_nome"


def eh_arquivo(href: str) -> bool:
    return Path(urlparse(href).path).suffix.lower() in EXTENSOES


def contexto_do_link(a: Tag):
    """Sobe na árvore para descobrir o ano e a IN a que o link pertence."""
    lis = [p for p in a.parents if isinstance(p, Tag) and p.name == "li"]
    ano, idx_ano = None, None
    for i, li in enumerate(lis):
        m = RE_ANO.match(texto_proprio(li))
        if m:
            ano, idx_ano = m.group(1), i
            break
    if ano is None:
        return None, None, None, "outro"

    # O <li> da IN é o ancestral imediatamente abaixo do <li> do ano
    li_in = lis[idx_ano - 1] if idx_ano >= 1 else None
    if li_in is None:
        return ano, "sem_numero", "", "principal"

    txt_in = texto_proprio(li_in)
    m = RE_IN.search(txt_in)
    if m:
        rotulo = f"IN_{m.group(1)}_{m.group(2)}"
        if m.group(3):
            rotulo += "_" + slug(m.group(3))
    else:
        rotulo = "sem_numero_" + slug(txt_in[:40])

    tipo = "principal" if idx_ano == 1 else "anexo"
    descricao = txt_in if tipo == "principal" else texto_proprio(lis[0])
    return ano, rotulo, descricao, tipo


def normaliza(url: str) -> str:
    p = urlparse(url)
    host = p.netloc.lower().replace("www.", "", 1) if p.netloc.lower().startswith("www.udesc") else p.netloc.lower()
    return f"{host}{p.path}"


def baixar(sessao, url, destino: Path, tentativas=3, verificar_ssl=True):
    if destino.exists() and destino.stat().st_size > 0:
        return "ja_existia"
    for t in range(1, tentativas + 1):
        try:
            with sessao.get(url, stream=True, timeout=60, verify=verificar_ssl) as r:
                r.raise_for_status()
                tmp = destino.with_suffix(destino.suffix + ".part")
                with open(tmp, "wb") as f:
                    for bloco in r.iter_content(64 * 1024):
                        f.write(bloco)
                tmp.rename(destino)
            return "ok"
        except Exception as e:
            erro = f"erro: {e}"
            time.sleep(2 * t)
    return erro


def main():
    ap = argparse.ArgumentParser(description="Baixa as Instruções Normativas da UDESC")
    ap.add_argument("--url", default=URL_PADRAO, help="Página com a lista de INs")
    ap.add_argument("--saida", default="instrucoes_normativas_udesc", help="Pasta de destino")
    ap.add_argument("--so-principais", action="store_true", help="Baixa só a IN, sem anexos/fluxogramas")
    ap.add_argument("--pausa", type=float, default=0.5, help="Segundos entre downloads")
    ap.add_argument("--inseguro", action="store_true", help="Não verifica certificado SSL")
    args = ap.parse_args()

    saida = Path(args.saida)
    saida.mkdir(parents=True, exist_ok=True)
    sessao = requests.Session()
    sessao.headers.update(HEADERS)
    verificar_ssl = not args.inseguro
    if args.inseguro:
        requests.packages.urllib3.disable_warnings()

    print(f"Lendo {args.url} ...")
    resp = sessao.get(args.url, timeout=60, verify=verificar_ssl)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    vistos = set()
    itens = []
    for a in soup.find_all("a", href=True):
        url = urljoin(args.url, a["href"].strip())
        if not eh_arquivo(url):
            continue
        chave = normaliza(url)
        if chave in vistos:
            continue
        vistos.add(chave)

        ano, rotulo, descricao, tipo = contexto_do_link(a)
        if args.so_principais and tipo != "principal":
            continue
        pasta = saida / (ano or "_outros") / (rotulo or "")
        nome = slug(Path(unquote(urlparse(url).path)).stem) + Path(urlparse(url).path).suffix.lower()
        itens.append((ano, rotulo, tipo, descricao, url, pasta / nome))

    print(f"{len(itens)} arquivos encontrados.\n")

    linhas = []
    for i, (ano, rotulo, tipo, descricao, url, destino) in enumerate(itens, 1):
        destino.parent.mkdir(parents=True, exist_ok=True)
        status = baixar(sessao, url, destino, verificar_ssl=verificar_ssl)
        print(f"[{i}/{len(itens)}] {status:10} {destino.relative_to(saida)}")
        linhas.append([ano, rotulo, tipo, descricao, url, str(destino.relative_to(saida)), status])
        if status == "ok":
            time.sleep(args.pausa)

    with open(saida / "manifesto.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["ano", "in", "tipo", "descricao", "url", "arquivo", "status"])
        w.writerows(linhas)

    falhas = [l for l in linhas if l[-1].startswith("erro")]
    print(f"\nConcluído: {len(linhas) - len(falhas)} ok, {len(falhas)} falhas. Veja {saida / 'manifesto.csv'}")


if __name__ == "__main__":
    main()