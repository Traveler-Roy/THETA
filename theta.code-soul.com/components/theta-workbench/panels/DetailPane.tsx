import type { WebAttachment, WebRunEvent, WebRunResults, WebRunStatus } from '../api/client.ts'
import { CatScientistAvatar, StateDot } from '../ui/index.ts'
import css from '../styles/app.module.css'
import { usePreferences } from '../preferences.tsx'
import { ResultsPreview } from './ResultsPreview.tsx'

interface DetailPaneProps {
  runId: string
  status?: WebRunStatus
  events: WebRunEvent[]
  results?: WebRunResults
  plan?: Record<string, unknown>
  onAttach: (attachment: WebAttachment) => void
}

interface ParameterEntry {
  label: string
  value: string
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const readableKey = (key: string): string => key
  .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
  .replace(/[_.-]+/gu, ' ')
  .replace(/\b\w/gu, (character) => character.toUpperCase())

const primitive = (value: unknown): string | undefined => {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value) && value.length <= 8 && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
    return value.join(', ')
  }
  return undefined
}

const MODEL_PARAMETER = /model|algorithm|topic|layer|neuron|hidden|epoch|batch|learning|rate|alpha|beta|seed|embedding|dimension|cluster|mode|covariate|iteration|dropout|window|min|max|k\b/iu
const PRIVATE_OR_PATH = /hash|path|ref|token|secret|key|dataset|corpus|file/iu

const parameterEntries = (value: unknown): ParameterEntry[] => {
  const entries: ParameterEntry[] = []
  const visit = (current: unknown, prefix = '', depth = 0): void => {
    if (entries.length >= 18 || depth > 3) return
    for (const [key, child] of Object.entries(record(current))) {
      const path = prefix ? `${prefix}.${key}` : key
      const formatted = primitive(child)
      if (formatted != null && MODEL_PARAMETER.test(path) && !PRIVATE_OR_PATH.test(path)) {
        entries.push({ label: readableKey(key), value: formatted })
      } else if (formatted == null) {
        visit(child, path, depth + 1)
      }
    }
  }
  visit(value)
  return entries
}

const trainingEvent = (event: WebRunEvent): boolean =>
  /training|train|训练/iu.test(`${event.type} ${event.title} ${event.detail ?? ''}`)

export const DetailPane = ({ runId, status, events, results, plan, onAttach }: DetailPaneProps): React.ReactElement => {
  const { locale } = usePreferences()
  const zh = locale === 'zh-CN'
  const resultMode = status?.status === 'completed' || (results?.visualizations.length ?? 0) > 0
  const statusRecord = record(status)
  const receipt = record(statusRecord.trainingReceipt)
  const parameters = parameterEntries({ plan, receipt })
  const presentationProgress = status?.presentation?.progress
  const rawProgress = presentationProgress?.percent ??
    (presentationProgress != null
      ? (presentationProgress.current / Math.max(presentationProgress.total, 1)) * 100
      : undefined) ??
    (typeof receipt.progress === 'number' ? receipt.progress : results?.progress ?? 0)
  const progress = Math.max(0, Math.min(100, rawProgress <= 1 ? rawProgress * 100 : rawProgress))
  const recentEvents = events.filter(trainingEvent).slice(-6).reverse()

  return (
    <aside className={css.detail} aria-label={zh ? '训练与结果' : 'Training and results'}>
      <div className={css.inspectorHeader}>
        <div>
          <span>{resultMode ? (zh ? '研究结果' : 'Research results') : (zh ? '训练监控' : 'Training monitor')}</span>
          <strong>{resultMode ? (zh ? '图表与分析产物' : 'Charts and artifacts') : (zh ? '模型运行状态' : 'Model run status')}</strong>
        </div>
        <StateDot size={8} state={status?.status === 'failed' ? 'error' : resultMode ? 'done' : 'ongoing'} />
      </div>

      {resultMode ? (
        <div className={css.inspectorBody}>
          <ResultsPreview runId={runId} results={results} onAttach={onAttach} />
        </div>
      ) : (
        <div className={css.inspectorBody}>
          <section className={css.trainingHero}>
            <div className={css.trainingHeroTitle}>
              <CatScientistAvatar size={34} />
              <div>
                <strong>{status?.presentation?.title ?? (zh ? '主题模型训练' : 'Topic-model training')}</strong>
                <span>{status?.currentState ?? (zh ? '正在启动' : 'Starting')}</span>
              </div>
              <b>{Math.round(progress)}%</b>
            </div>
            <div className={css.trainingProgress} aria-label={`${Math.round(progress)}%`}>
              <span style={{ width: `${progress}%` }} />
            </div>
            {status?.presentation?.summary && <p>{status.presentation.summary}</p>}
          </section>

          {parameters.length > 0 && (
            <section className={css.inspectorSection}>
              <h3>{zh ? '模型配置' : 'Model configuration'}</h3>
              <div className={css.parameterGrid}>
                {parameters.map((parameter, index) => (
                  <div key={`${parameter.label}-${index}`}>
                    <span>{parameter.label}</span>
                    <strong>{parameter.value}</strong>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className={css.inspectorSection}>
            <h3>{zh ? '训练信息' : 'Training activity'}</h3>
            {recentEvents.length === 0 ? (
              <p className={css.inspectorEmpty}>{zh ? '等待训练运行器返回首个进度事件…' : 'Waiting for the first runner progress event…'}</p>
            ) : (
              <div className={css.trainingTimeline}>
                {recentEvents.map((event, index) => (
                  <div key={event.id}>
                    <StateDot size={7} state={index === 0 && status?.status !== 'failed' ? 'ongoing' : event.type.includes('failed') ? 'error' : 'done'} />
                    <span><strong>{event.title}</strong>{event.detail && <small>{event.detail}</small>}</span>
                    <time>{new Date(event.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</time>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </aside>
  )
}
