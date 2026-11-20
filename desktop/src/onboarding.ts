export const GUIDE_KEY = 'migration-guide-v1';
export type GuideChoice = 'choose' | 'all';
type GuideStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export function needsGuide(storage: Pick<GuideStorage, 'getItem'>) {
  try { return storage.getItem(GUIDE_KEY) !== 'done'; } catch { return true; }
}
export function completeGuide(storage: Pick<GuideStorage, 'setItem'>) {
  try { storage.setItem(GUIDE_KEY, 'done'); return true; } catch { return false; }
}
export function guideStep(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(2, Math.trunc(value))) : 0;
}

export function guideHTML(current: number, direction: string, choice: GuideChoice) {
  const step = guideStep(current), reverse = direction === 'oc-to-dsh';
  const target = reverse ? 'DeepSeek Harness' : 'OpenCode';
  const titles = ['选好迁移方向', '决定搬哪些对话', '了解怎么检查与撤销'];
  const heading = ['你想把对话搬到哪里？', '先挑几条，还是全部搬走？', '搬完以后，去新工具看看。'][step];
  const body = step === 0 ? `
    <p class="guide-description">箭头指向要搬入的工具。DeepSeek Harness 在这里也简称 DSH。</p>
    <div class="guide-directions" role="group" aria-label="教程中的迁移方向">
      ${(['dsh-to-oc', 'oc-to-dsh'] as const).map(d => `<button class="guide-choice" data-action="direction" data-direction="${d}" aria-pressed="${direction === d}"><span class="choice-check" aria-hidden="true"></span><span><strong>${d === 'dsh-to-oc' ? 'DeepSeek Harness → OpenCode' : 'OpenCode → DeepSeek Harness'}</strong><small>${d === 'dsh-to-oc' ? '以后在 OpenCode 里接着聊。' : '以后在 DeepSeek Harness 里接着聊。'}</small></span></button>`).join('')}
    </div>
    <p class="guide-note">${reverse ? '搬入 DeepSeek Harness 前，请先完全退出它；搬完再重新打开。' : '先安装好 OpenCode，并在原工具里结束正在进行的对话。'}</p>` : step === 1 ? `
    <p class="guide-description">第一次用，建议先扫描，确认标题和项目后再选择。</p>
    <div class="guide-choices" role="group" aria-label="选择迁移方式">
      <button class="guide-choice" data-action="guideChoice" data-choice="choose" aria-pressed="${choice === 'choose'}"><span class="choice-check" aria-hidden="true"></span><span><strong>先扫描，再挑选 <em>推荐</em></strong><small>先列出对话，不会开始迁移。可以按项目、标题查找和勾选。</small></span></button>
      <button class="guide-choice" data-action="guideChoice" data-choice="all" aria-pressed="${choice === 'all'}"><span class="choice-check" aria-hidden="true"></span><span><strong>全部搬走</strong><small>把找到的所有对话逐个搬过去。开始后，也可以停止。</small></span></button>
    </div>
    <p class="guide-note">原工具里的对话会保留。教程里的选择不会自动开始迁移。</p>
    <p class="guide-note">扫描时，系统可能会出现权限弹窗。请授予对话文件夹必要的文件读取权限，再继续扫描。</p>` : `
    <p class="guide-description">这次要搬到 ${target}。完成后，用这三件事确认结果。</p>
    <ol class="guide-checklist">
      <li><span>1</span><div><strong>先看迁移结果</strong><p>工具会核对迁入的标题和正文。有问题的对话会单独列出来。</p></div></li>
      <li><span>2</span><div><strong>再打开 ${target}</strong><p>找到刚搬入的对话，看看项目、标题和内容是否符合预期。</p></div></li>
      <li><span>3</span><div><strong>想撤销，就去「迁移记录」</strong><p>点击「撤销这次迁移」，只清理本次新增且未继续使用的对话。被原工具占用的记录会保留。</p></div></li>
    </ol>`;
  return `<section class="onboarding" aria-label="首次使用教程">
    <nav class="guide-steps" aria-label="教程步骤"><ol>${titles.map((title, index) => `<li><button data-action="guideStep" data-step="${index}" ${index === step ? 'aria-current="step"' : ''}><span class="guide-step-number">${index < step ? '✓' : index + 1}</span><span>${title}</span></button></li>`).join('')}</ol><p>三步了解流程。<br>熟悉后可以直接跳过。</p></nav>
    <div class="guide-panel"><div class="guide-progress">第 ${step + 1} 步，共 3 步</div><h2 id="guide-step-heading" tabindex="-1">${heading}</h2>${body}
      <div class="guide-actions"><button class="text-button" data-action="guideSkip">跳过教程</button><div>${step > 0 ? '<button class="button secondary" data-action="guidePrevious">上一步</button>' : ''}<button class="button primary" data-action="${step === 2 ? 'guideFinish' : 'guideNext'}">${step === 2 ? choice === 'all' ? '前往一键迁移' : '开始扫描对话' : '下一步'}<span aria-hidden="true">→</span></button></div></div>
    </div>
  </section>`;
}
