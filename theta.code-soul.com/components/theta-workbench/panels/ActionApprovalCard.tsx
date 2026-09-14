import { useId, useRef, useState } from 'react'
import { Check, ChevronRight, CircleHelp, Loader2, Pencil, X } from 'lucide-react'
import { postAction, type WebAgentInteraction } from '../api/client.ts'
import css from './ActionApprovalCard.module.css'

type Props = { runId: string; interaction: WebAgentInteraction; onApproved: () => void; decisionError?: string }

/** One decision applies only to the displayed version of one operation. */
export function ActionApprovalCard({ runId, interaction, onApproved, decisionError }: Props): React.ReactElement {
  const card = interaction.card!
  const titleId = useId()
  const feedbackId = useId()
  const draftKey = `theta.card-feedback.${runId}.${card.actionRef}.${card.contentHash}`
  const [feedback, setFeedback] = useState(() => {
    try { return sessionStorage.getItem(draftKey) ?? '' } catch { return '' }
  })
  const [editing, setEditing] = useState(() => !!feedback)
  const [busy, setBusy] = useState<'approve' | 'reject' | 'revise'>()
  const [error, setError] = useState(decisionError ?? '')
  const inFlight = useRef(false)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const preparing = interaction.status === 'running'
  const unavailable = busy != null || preparing
  const lines = card.description.split('\n').map(line => line.trim()).filter(Boolean)
  const fields = lines.flatMap(line => {
    const match = /^(数据|方法|模型|文本列|时间列|设备|最长运行)[:：]\s*(.+)$/u.exec(line)
    return match ? [{ label: match[1], value: match[2] }] : []
  })
  const scopeNotes = lines.filter(line => /^(Embedding|外部|接收端|本次额度)/u.test(line))
  const taskLine = lines.find(line => /^任务[:：]/u.test(line))
  const overviewLines = lines.filter((line, index) => !/^任务[:：]/u.test(line) && !(index === 0 && /[？?]$/u.test(line)))
  const parameters = lines.find(line => /^参数[:：]/u.test(line))
  if (parameters) {
    try {
      const params = JSON.parse(parameters.replace(/^参数[:：]\s*/u, '')) as Record<string, unknown>
      if (params.num_topics != null) fields.push({ label: '主题数', value: String(params.num_topics) })
      if (params.max_iter != null) fields.push({ label: '迭代上限', value: `${params.max_iter} 次` })
      if (params.epochs != null) fields.push({ label: '训练轮数', value: `${params.epochs} 轮` })
    } catch { /* The complete, authoritative description remains available below. */ }
  }
  const fieldOrder = ['数据', '方法', '模型', '文本列', '时间列', '设备', '最长运行', '主题数', '迭代上限', '训练轮数']
  fields.sort((a, b) => fieldOrder.indexOf(a.label) - fieldOrder.indexOf(b.label))
  const edit = (value: string) => {
    setFeedback(value)
    try { sessionStorage.setItem(draftKey, value) } catch { /* Optional draft persistence. */ }
  }
  const submit = async (action: 'approve' | 'reject' | 'revise') => {
    if (inFlight.current || preparing) return
    if (action === 'revise' && !feedback.trim()) { setError('请填写要修改的内容。'); return }
    if (action === 'approve' && feedback.trim()) return
    inFlight.current = true
    setBusy(action)
    setError('')
    try {
      await postAction(runId, { action: action === 'approve' ? 'approveCheckpoint' : action,
        checkpointId: card.actionRef, expectedContentHash: card.contentHash,
        reason: action === 'reject' ? `拒绝本次操作，暂不执行。${feedback.trim()}` : feedback.trim() })
      try { sessionStorage.removeItem(draftKey) } catch { /* Optional draft persistence. */ }
      // Remain locked until the parent receives the authoritative decision state.
      onApproved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      inFlight.current = false
      setBusy(undefined)
      onApproved()
    }
  }
  const stateText = busy === 'approve' ? '正在确认操作' : busy === 'reject' ? '正在拒绝操作' : busy === 'revise' ? '正在提交修改' : preparing ? 'Agent 正在处理' : '等待你的确认'
  return (
    <section className={css.card} aria-labelledby={titleId} aria-busy={unavailable}>
      <header className={css.header}>
        <span className={css.requestIcon} aria-hidden="true">{unavailable ? <Loader2 className={css.spinner} size={18} /> : <CircleHelp size={18} />}</span>
        <div className={css.heading}><strong id={titleId}>{card.title}</strong><span role="status">{stateText}</span></div>
      </header>
      <div className={css.body}>
        {fields.length > 0 ? <dl className={css.facts}>{fields.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl>
          : <div><p className={css.overview}>{overviewLines.slice(0, 3).join('\n')}</p>{taskLine && <p className={css.taskRef} title={taskLine}>{taskLine.replace(/job-[a-f0-9]{16,}/gu, id => `${id.slice(0, 12)}…`)}</p>}</div>}
        {scopeNotes.length > 0 && <p className={css.scopeNotes}>{scopeNotes.join('\n')}</p>}
        <details className={css.details}>
          <summary><ChevronRight size={14} aria-hidden="true" />完整方案与执行范围</summary>
          <p>{card.description}</p>
        </details>
        {editing && <label className={css.feedback} htmlFor={feedbackId}>
          <span>希望怎样修改？</span>
          <textarea id={feedbackId} aria-label="修改意见" rows={2} maxLength={4000} value={feedback} disabled={unavailable} autoFocus
            placeholder="例如：把迭代次数改为 10，其他设置保持不变。"
            onChange={event => edit(event.target.value)} />
          <small>提交后由 Agent 更新方案，新方案仍需你确认。</small>
        </label>}
        {error && <p className={css.error} role="alert">{error} 意见已保留，请核对当前卡片后重试。</p>}
      </div>
      <footer className={css.footer}>
        <span className={css.scope}>{editing ? '修改不会启动本次操作' : '仅确认本次操作'}</span>
        <div className={css.actions}>
          <button type="button" className={css.secondary} disabled={unavailable} onClick={() => void submit('reject')}>{busy === 'reject' ? <Loader2 size={14} className={css.spinner} /> : <X size={14} />}{busy === 'reject' ? '拒绝中…' : '拒绝本次'}</button>
          {editing ? <button type="button" className={css.secondary} disabled={unavailable} onClick={() => { edit(''); setEditing(false); setError(''); window.requestAnimationFrame(() => editButtonRef.current?.focus()) }}>取消修改</button>
            : <button ref={editButtonRef} type="button" className={css.secondary} disabled={unavailable} onClick={() => setEditing(true)}><Pencil size={14} />修改方案</button>}
          <button type="button" className={css.primary} disabled={unavailable || (editing ? !feedback.trim() : !!feedback.trim())} onClick={() => void submit(editing ? 'revise' : 'approve')}>
            {busy && busy !== 'reject' ? <Loader2 size={14} className={css.spinner} /> : editing ? <Pencil size={14} /> : <Check size={15} />}
            {busy && busy !== 'reject' ? '提交中…' : editing ? '提交修改' : '确认执行'}
          </button>
        </div>
      </footer>
    </section>
  )
}
