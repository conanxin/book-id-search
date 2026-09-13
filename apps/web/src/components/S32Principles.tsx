type S32Principle = {
  id: string;
  title: string;
  description: string;
  technical: string;
};

const S32_PRINCIPLES: readonly S32Principle[] = [
  {
    id: "01",
    title: "作品、版本和原始书目不是同一件事",
    description:
      "原始书目记录先保留，再逐步解析到真正的作品与版本；重复记录不等于重复作品。",
    technical: "Work ≠ Edition ≠ CatalogRecord",
  },
  {
    id: "02",
    title: "长期阅读关系和某一次阅读不是同一件事",
    description:
      "Reading 表示我与某个版本之间的长期关系，ReadingSession 记录第一次阅读、重读或专题性阅读。",
    technical: "Reading ≠ ReadingSession",
  },
  {
    id: "03",
    title: "书中原文、我的笔记和 AI 内容必须分开",
    description:
      "来源文本、用户自己的理解和模型生成内容拥有不同身份，避免多年后无法判断一句话究竟是谁写的。",
    technical: "Highlight ≠ Note ≠ AIArtifact",
  },
  {
    id: "04",
    title: "每份材料都应该知道自己从哪里来",
    description:
      "来源平台、具体资料、数字文件及其对应的作品或版本分别记录，让每条材料都能追溯 provenance。",
    technical: "Provider → Source → SourceAsset / SourceBinding",
  },
  {
    id: "05",
    title: "不仅记录“在哪里”，还保存“是哪段内容”",
    description:
      "Locator 保存页码、CFI、range 或坐标；Anchor 保存原文及上下文锚点，位置变化后仍有机会重新定位。",
    technical: "Locator + Anchor",
  },
  {
    id: "06",
    title: "可能相同、确认相同和实体合并是三件事",
    description:
      "自动匹配可以提出候选，但确认和合并必须有明确证据；真正的合并保持可审计、可撤销。",
    technical: "Match ≠ Resolve ≠ Merge",
  },
  {
    id: "07",
    title: "数据库事实和研究判断分开表达",
    description:
      "结构关系由数据库约束保证；观点、证据、主题和开放语义关系作为可演化、可争议的研究知识保存。",
    technical:
      "Structural Relation ≠ Semantic Relation · Claim / Evidence / Topic",
  },
  {
    id: "08",
    title: "私人数据经过 AI 或索引处理后仍默认保持私人",
    description:
      "所有权、可见性、访问范围、权利和派生关系分别管理；派生数据默认继承输入中最严格的限制。",
    technical:
      "Ownership / Visibility / Access Scope / Rights / Derivation",
  },
  {
    id: "09",
    title: "保留当前状态，也保留认识形成和变化的历史",
    description:
      "当前状态服务日常使用，追加式历史保存笔记、观点、匹配和来源状态为何演变成今天的样子。",
    technical: "Current State + Append-only History",
  },
  {
    id: "10",
    title: "任何外部数据都可以安全重复导入",
    description:
      "原始输入先进入可审计的 ingestion 层；同一数据重复运行不会制造重复对象，身份不确定时保持 ambiguous。",
    technical: "ImportBatch / RawRecord / Idempotent Ingestion",
  },
];

export default function S32Principles() {
  return (
    <section
      className="s32-principles"
      aria-label="S32 个人阅读知识层设计原则"
      data-testid="s32-principles"
    >
      <details className="s32-principles__details">
        <summary className="s32-principles__summary">
          <span className="s32-principles__summary-copy">
            <strong>S32｜个人阅读知识层设计原则</strong>
            <span>
              10 条原则 · 查看项目如何处理书、阅读、来源、证据、隐私与历史
            </span>
          </span>
        </summary>

        <div className="s32-principles__body">
          <p className="s32-principles__status">
            设计状态：原则已确认，功能将按阶段逐步实现。
          </p>

          <p className="s32-principles__intro">
            S32 的目标不是单纯保存书和笔记，而是让一个知识判断可以追溯到：
            读的是哪部作品的哪个版本、通过什么来源看到哪段原文、当时写了什么，
            以及后来为什么形成或修改了某个结论。
          </p>

          <ol className="s32-principles__list">
            {S32_PRINCIPLES.map((principle) => (
              <li
                className="s32-principles__item"
                key={principle.id}
              >
                <div className="s32-principles__item-head">
                  <span className="s32-principles__number">
                    {principle.id}
                  </span>
                  <strong>{principle.title}</strong>
                </div>

                <p className="s32-principles__plain">
                  {principle.description}
                </p>

                <code className="s32-principles__technical">
                  {principle.technical}
                </code>
              </li>
            ))}
          </ol>

          <p className="s32-principles__footer">
            这些原则是 S32 的持续设计约束；后续确认的新原则会继续加入这里。
          </p>
        </div>
      </details>
    </section>
  );
}
