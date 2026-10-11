// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { BookProse } from "./BookProse";

afterEach(cleanup);
const view = (content: string) => <MemoryRouter><BookProse content={content} /></MemoryRouter>;

describe("book prose", () => {
  it("renders reading structure while keeping source headings inside the book section", () => {
    const { container } = render(view("# 阅读方向\n\n## 古道与聚落\n\n### 原文线索\n\n正文包含 **重点**、*存疑* 和 `页码 208`。\n\n> 需要回到原书核对。\n\n1. 查看地图\n2. 对照地方志\n\n- 实地记录\n  - 补充照片\n\n```text\n第一行\n第二行\n```"));
    expect(screen.getByRole("heading", { name: "阅读方向", level: 4 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "古道与聚落", level: 4 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "原文线索", level: 5 })).toBeTruthy();
    expect(container.querySelector("h1,h2,h3")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("重点");
    expect(container.querySelector("em")?.textContent).toBe("存疑");
    expect(container.querySelector("blockquote")?.textContent).toContain("需要回到原书核对。");
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("ul ul")?.textContent).toContain("补充照片");
    expect(screen.getByLabelText("代码块").textContent).toBe("第一行\n第二行\n");
  });

  it("keeps plain-text line breaks and literal markup readable without changing the source", () => {
    const content = "第一行\n第二行\n第三行\n\n\\*不是斜体\\*；正文里的 <span>原样标签</span>。";
    const { container } = render(view(content));
    expect(container.querySelector("p")?.textContent).toBe("第一行\n第二行\n第三行");
    expect(screen.getByText("*不是斜体*；正文里的 <span>原样标签</span>。")).toBeTruthy();
    expect(container.querySelector("em")).toBeNull();
    expect(content).toContain("\\*不是斜体\\*");
  });

  it("renders GFM tables, read-only tasks and ordinary pasted web links", () => {
    render(view("| 地点 | 证据 |\n| --- | --- |\n| 山口 | 碑刻 |\n\n- [x] 已核原文\n- [ ] 待查版本\n\nhttps://archive.example.test/catalog?book=harpoon#page=21"));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map(item => item.textContent)).toEqual(["地点", "证据"]);
    expect(within(table).getByRole("cell", { name: "碑刻" })).toBeTruthy();
    const tasks = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(tasks.map(task => [task.checked, task.disabled])).toEqual([[true, true], [false, true]]);
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://archive.example.test/catalog?book=harpoon#page=21");
  });

  it("uses router navigation for book and WeRead sources without losing their fragment or query", () => {
    function Location() {
      const location = useLocation();
      return <output aria-label="当前位置">{location.pathname}{location.search}{location.hash}</output>;
    }
    render(<MemoryRouter initialEntries={["/books/current"]}>
      <BookProse content={"[查看笔记来源](/books/book-a#book-note-note-a) · [微信读书来源](/weread?bookId=weread-a&tab=notes#note-7) · [原版扫描](https://archive.example.test/book.pdf#page=21)"} />
      <Location />
    </MemoryRouter>);
    fireEvent.click(screen.getByRole("link", { name: "查看笔记来源" }));
    expect(screen.getByLabelText("当前位置").textContent).toBe("/books/book-a#book-note-note-a");
    fireEvent.click(screen.getByRole("link", { name: "微信读书来源" }));
    expect(screen.getByLabelText("当前位置").textContent).toBe("/weread?bookId=weread-a&tab=notes#note-7");
    const external = screen.getByRole("link", { name: "原版扫描" });
    expect(external.getAttribute("href")).toBe("https://archive.example.test/book.pdf#page=21");
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("does not execute raw HTML or turn non-web protocols into active links", () => {
    const { container } = render(view("[脚本](javascript:alert%281%29) [混淆脚本](java&#x73;cript:alert%281%29) [数据](data:text/html,hello) [文件](file:///tmp/book.pdf)\n\n<script>alert('x')</script>\n\n<iframe src=\"https://example.test/embed\"></iframe>\n\n<img src=\"https://example.test/tracker.png\" onerror=\"alert(1)\">"));
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.querySelector("script,iframe,img,object,embed,video,audio")).toBeNull();
    expect(screen.getByText("脚本")).toBeTruthy();
    expect(container.textContent).toContain("<iframe");
  });

  it("turns images into explicit references, including images already wrapped in a link", () => {
    const { container } = render(view("![古道示意图](https://example.test/map.png)\n\n[![扫描封面](https://example.test/cover.png)](https://example.test/book.pdf)\n\n![无效图像](data:image/png;base64,abc)"));
    expect(container.querySelector("img")).toBeNull();
    const image = screen.getByRole("link", { name: "图片：古道示意图（查看图片）" });
    expect(image.getAttribute("href")).toBe("https://example.test/map.png");
    const linkedImage = screen.getByRole("link", { name: "图片：扫描封面" });
    expect(linkedImage.getAttribute("href")).toBe("https://example.test/book.pdf");
    expect(linkedImage.querySelector("a")).toBeNull();
    expect(screen.getByText("图片：无效图像")).toBeTruthy();
  });

  it("keeps footnote references and accessible labels separate across multiple saved notes", () => {
    const first = "第一篇正文[^1]。\n\n[^1]: 第一篇的注释。";
    const second = "第二篇正文[^1]。\n\n[^1]: 第二篇的注释。";
    const { container, rerender } = render(<MemoryRouter><BookProse content={first} /><BookProse content={second} /></MemoryRouter>);
    const ids = [...container.querySelectorAll("[id]")].map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const prose of container.querySelectorAll(".book-prose")) {
      const reference = prose.querySelector<HTMLAnchorElement>("a[data-footnote-ref]")!;
      const footnote = document.getElementById(reference.getAttribute("href")!.slice(1));
      expect(footnote && prose.contains(footnote)).toBe(true);
      const label = document.getElementById(reference.getAttribute("aria-describedby")!);
      expect(label && prose.contains(label)).toBe(true);
      expect(label?.textContent).toBe("注释");
      const back = prose.querySelector<HTMLAnchorElement>("a[data-footnote-backref]")!;
      expect(document.getElementById(back.getAttribute("href")!.slice(1))).toBe(reference);
    }
    rerender(<MemoryRouter><BookProse content={first} /><BookProse content={second} /></MemoryRouter>);
    expect([...container.querySelectorAll("[id]")].map(element => element.id)).toEqual(ids);
  });
});
