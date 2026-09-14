import { useEffect, useRef, useState } from 'react'
import {
  cancelRunTraining, createRun, getRunWorkspaces, invokeRunTool, postMessage,
  runWorkflowAction, uploadDataset,
  type WebAttachment, type WebMessage, type WebReasoning, type WebRunDetail, type WebRunEvent, type WebRunResults,
  type WebRunStatus, type WebRunWorkspaces,
} from '../api/client.ts'
import {
  Button, IconCheckOutline16, IconDataOutline16, IconFolderOpenOutline16,
  IconGoalOutline16, IconListPenOutline16, IconPlayOutline16,
  IconRefreshOutline16, IconSettingsOutline16, IconTrashOutline16,
} from '../ui/index.ts'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import css from '../styles/app.module.css'

export type ManualStage = 'data' | 'research' | 'plan' | 'training' | 'results'
export type ManualOperationAction =
  | 'upload'
  | 'inspect'
  | 'dataset'
  | 'research-save'
  | 'models'
  | 'plan'
  | 'discover'
  | 'research'
  | 'plan-design'
  | 'prepare-training'
  | 'advance-training'
  | 'cancel'

export interface ManualOperationStatus {
  id: string
  runId?: string
  action: ManualOperationAction
  label: string
  detail: string
  startedAt: string
  state: 'running' | 'completed' | 'failed'
  completedAt?: string
  completionDetail?: string
  error?: string
}

interface DatasetOverview {
  fileName?: string
  format?: string
  sizeBytes?: number
  rowCount?: number
  columns?: string[]
  candidateRoles?: {
    text?: Array<{ name: string; columnRef?: string; score: number; reason: string }>
    time?: Array<{ name: string; columnRef?: string; score: number; reason: string }>
    metadata?: Array<{ name: string; columnRef?: string; score: number; reason: string }>
  }
  inferredDomain?: { label?: string; confidence?: number }
  qualityWarnings?: string[]
}

interface DatasetSample {
  sampleRows?: Array<Record<string, unknown>>
  redactionSummary?: { applied?: boolean; redactedValueCount?: number }
}

interface ModelCatalogEntry {
  id: string
  name: string
  type: string
  params: Record<string, unknown>
  runnable?: boolean
  experimental?: boolean
}

interface ManualWorkspaceProps {
  runId?: string
  status?: WebRunStatus
  detail?: WebRunDetail
  reasoning?: WebReasoning
  events: WebRunEvent[]
  results?: WebRunResults
  loading: boolean
  error?: string
  onCreated: (runId: string, suggestedName?: string) => void
  onEnsureProject: (suggestedName: string) => Promise<string>
  onRefresh: () => void
  activeOperation?: ManualOperationStatus
  draft: ManualWorkspaceDraft
  onDraftChange: (updater: ManualWorkspaceDraft | ((current: ManualWorkspaceDraft) => ManualWorkspaceDraft)) => void
  onOperationChange?: (operation: ManualOperationStatus) => void
  onConversationMessages?: (runId: string, messages: WebMessage[]) => void
  onConversationNotice?: (content: string) => void
  conversationAttachments?: WebAttachment[]
  conversationMessages?: WebMessage[]
  capturedActivity?: unknown
}

const STAGES: Array<{ id: ManualStage; label: string; icon: typeof IconDataOutline16 }> = [
  { id: 'data', label: '数据管理', icon: IconDataOutline16 },
  { id: 'research', label: '研究设置', icon: IconGoalOutline16 },
  { id: 'plan', label: '模型与参数', icon: IconSettingsOutline16 },
  { id: 'training', label: '模型训练', icon: IconPlayOutline16 },
  { id: 'results', label: '结果分析', icon: IconListPenOutline16 },
]

const CLEANING_OPTIONS = [
  ['removeUrls', '删除 URL'], ['removeHtml', '删除 HTML 标签'],
  ['removePunctuation', '删除标点'], ['removeStopwords', '删除停用词'],
  ['removeSpecial', '删除特殊字符'], ['normalizeWhitespace', '规范化空白'],
] as const

type CleaningKey = (typeof CLEANING_OPTIONS)[number][0]
type CleaningState = Record<CleaningKey, boolean>
const DEFAULT_CLEANING: CleaningState = {
  removeUrls: true, removeHtml: true, removePunctuation: true,
  removeStopwords: true, removeSpecial: true, normalizeWhitespace: true,
}
const DEFAULT_PARAMETERS = {
  vocabularySize: 5000, topicCount: 20, epochs: 100, batchSize: 64,
  learningRate: 0.002, hiddenSize: 512, earlyStopping: 10,
}

const ANALYSIS_GOALS = [
  { id: 'topic_discovery', label: '主题发现', description: '识别主要主题、关键词与主题关系。' },
  { id: 'trend_analysis', label: '趋势分析', description: '分析主题或指标随时间的变化。' },
  { id: 'sentiment', label: '情感与反馈', description: '关注情绪倾向、问题和负面反馈。' },
  { id: 'classification', label: '训练与评估', description: '生成或评估文本分类、主题识别任务。' },
] as const

const DELIVERABLES = [
  { id: 'report', label: '分析报告' },
  { id: 'visualization', label: '可视化图表' },
  { id: 'clean_dataset', label: '清洗后的数据集' },
  { id: 'training_dataset', label: 'NLP 训练数据集' },
  { id: 'topic_labels', label: '主题与标签结果' },
] as const

type AnalysisGoal = '' | (typeof ANALYSIS_GOALS)[number]['id']
type Deliverable = '' | (typeof DELIVERABLES)[number]['id']
type ModelSize = '0.6B' | '4B' | '8B'
type EmbeddingMode = 'zero-shot' | 'unsupervised' | 'supervised'

export interface ManualWorkspaceDraft {
  activeStage: ManualStage
  pendingFile?: File
  primaryTextColumn: string
  timeColumn: string
  metadataColumns: string[]
  cleaning: CleaningState
  minimumWords: number
  analysisGoal: AnalysisGoal
  deliverable: Deliverable
  researchGoal: string
  language: 'zh' | 'en'
  selectedModels: string[]
  modelSelectionTouched: boolean
  modelSize: ModelSize
  embeddingMode: EmbeddingMode
  parameters: typeof DEFAULT_PARAMETERS
  parametersTouched: boolean
  savedPlanFingerprint?: string
}

export const createManualWorkspaceDraft = (): ManualWorkspaceDraft => ({
  activeStage: 'data',
  primaryTextColumn: '',
  timeColumn: '',
  metadataColumns: [],
  cleaning: { ...DEFAULT_CLEANING },
  minimumWords: 3,
  analysisGoal: '',
  deliverable: '',
  researchGoal: '',
  language: 'zh',
  selectedModels: [],
  modelSelectionTouched: false,
  modelSize: '0.6B',
  embeddingMode: 'zero-shot',
  parameters: { ...DEFAULT_PARAMETERS },
  parametersTouched: false,
  savedPlanFingerprint: undefined,
})

const DRAFT_MODEL_CATALOG: ModelCatalogEntry[] = [
  { id: 'theta', name: 'THETA', type: '神经主题模型', params: {} },
  { id: 'nvdm', name: 'NVDM', type: '神经主题模型', params: {} },
  { id: 'gsm', name: 'GSM', type: '神经主题模型', params: {} },
  { id: 'prodlda', name: 'ProdLDA', type: '神经主题模型', params: {} },
  { id: 'ctm', name: 'CTM', type: '神经主题模型', params: {} },
  { id: 'etm', name: 'ETM', type: '神经主题模型', params: {} },
  { id: 'dtm', name: 'DTM', type: '时序主题模型', params: {} },
  { id: 'bertopic', name: 'BERTopic', type: '嵌入主题模型', params: {} },
  { id: 'lda', name: 'LDA', type: '传统主题模型', params: {} },
  { id: 'hdp', name: 'HDP', type: '传统主题模型', params: {} },
  { id: 'stm', name: 'STM', type: '结构主题模型', params: {} },
  { id: 'btm', name: 'BTM', type: '短文本主题模型', params: {} },
]

const OPERATION_COPY: Record<ManualOperationAction, { label: string; detail: string }> = {
  upload: { label: '正在上传数据并创建研究任务', detail: 'THETA 正在登记数据集并建立同一项目下的研究 Run。' },
  inspect: { label: '正在读取数据结构与预览', detail: 'THETA 正在通过数据集 tools 读取字段、样本和质量信息。' },
  dataset: { label: '正在保存数据配置', detail: 'THETA 正在将列角色和清洗规则写入当前 DatasetWorkspace。' },
  'research-save': { label: '正在保存研究设置', detail: 'THETA 正在将研究目标写入当前 ResearchWorkspace。' },
  models: { label: '正在读取模型目录', detail: 'THETA 正在通过受治理 tool 获取当前可运行模型。' },
  plan: { label: '正在保存模型与参数', detail: 'THETA 正在校验并写入当前项目的候选计划。' },
  discover: { label: '正在运行数据检查', detail: 'THETA 正在理解数据结构、字段角色和数据质量。' },
  research: { label: '正在梳理研究问题', detail: 'THETA 正在结合数据理解识别研究目标和待确认问题。' },
  'plan-design': { label: '正在生成分析方案', detail: 'THETA 正在比较模型能力并生成可审查的分析计划。' },
  'prepare-training': { label: '正在准备模型训练', detail: 'THETA 正在校验数据、计划和训练前置条件。' },
  'advance-training': { label: '正在推进模型训练', detail: 'THETA 正在调用当前 Run 的训练接口并同步训练状态。' },
  cancel: { label: '正在取消模型训练', detail: 'THETA 正在向当前训练任务提交取消请求。' },
}

interface AutomaticTrainingStep {
  operation: Extract<ManualOperationAction, 'discover' | 'research' | 'plan-design' | 'prepare-training' | 'advance-training'>
  action: 'discover' | 'research' | 'plan-design' | 'prepare-training' | 'advance-training'
  completionDetail: string
}

const automaticTrainingStep = (currentState?: string): AutomaticTrainingStep | undefined => {
  switch (currentState) {
    case 'DatasetDiscovery':
      return {
        operation: 'discover',
        action: 'discover',
        completionDetail: '数据理解已完成，请确认当前数据理解后继续。',
      }
    case 'ResearchDialogue':
      return {
        operation: 'research',
        action: 'research',
        completionDetail: '研究问题梳理已完成，请确认当前研究设置后继续。',
      }
    case 'PlanDesign':
      return {
        operation: 'plan-design',
        action: 'plan-design',
        completionDetail: '候选分析方案已生成，请确认当前方案后继续。',
      }
    case 'CreatePlan':
    case 'DryRun':
      return {
        operation: 'prepare-training',
        action: 'prepare-training',
        completionDetail: '训练计划与参数校验已完成；正式启动训练前仍需完成审批。',
      }
    case 'VerifyDataset':
      return {
        operation: 'advance-training',
        action: 'advance-training',
        completionDetail: '训练前数据校验已完成，等待你明确启动模型训练。',
      }
    default:
      return undefined
  }
}

const TRAINING_CONFIRMATION_COPY: Record<string, string> = {
  DatasetCheckpoint: '数据理解已经形成，请在当前页面下方的确认卡片中核对并确认。',
  ResearchCheckpoint: '研究目标已经形成，请在当前页面下方的确认卡片中核对并确认。',
  PlanConfirmation: '候选分析方案已经形成，请在当前页面下方的确认卡片中核对并确认。',
  TrainingConfirmation: '训练前校验已经完成，请在当前页面下方的审批卡片中确认；确认后仍不会自动启动训练。',
}

const datasetNarrative = (value: string): string =>
  value === 'Dataset discovery has started; verified observations are still being collected.'
    ? '数据集理解已开始，THETA 正在收集并核验数据结构、字段角色和质量观察。'
    : value

const analysisGoalLabel = (value: AnalysisGoal): string => ANALYSIS_GOALS.find((item) => item.id === value)?.label ?? ''
const deliverableLabel = (value: Deliverable): string => DELIVERABLES.find((item) => item.id === value)?.label ?? ''
const researchSummary = (draft: ManualWorkspaceDraft): string => [
  draft.analysisGoal ? `分析方向：${analysisGoalLabel(draft.analysisGoal)}` : '',
  draft.deliverable ? `预期交付：${deliverableLabel(draft.deliverable)}` : '',
  draft.researchGoal.trim() ? `补充说明：${draft.researchGoal.trim()}` : '',
].filter(Boolean).join('；')

const inferAnalysisGoal = (value: unknown): AnalysisGoal => {
  const text = JSON.stringify(value ?? '').toLowerCase()
  if (/情感|情绪|负面|sentiment|feedback/u.test(text)) return 'sentiment'
  if (/时间|趋势|变化|trend|temporal|timeline/u.test(text)) return 'trend_analysis'
  if (/分类|训练|评估|classification|training|evaluation/u.test(text)) return 'classification'
  if (/主题|关键词|聚类|topic|keyword|cluster/u.test(text)) return 'topic_discovery'
  return ''
}

const inferDeliverable = (value: unknown): Deliverable => {
  const text = JSON.stringify(value ?? '').toLowerCase()
  if (/可视化|图表|visual/u.test(text)) return 'visualization'
  if (/清洗.*数据|clean.*dataset/u.test(text)) return 'clean_dataset'
  if (/训练数据|training.*dataset/u.test(text)) return 'training_dataset'
  if (/标签|主题结果|label|topic.*result/u.test(text)) return 'topic_labels'
  if (/报告|总结|report|summary/u.test(text)) return 'report'
  return ''
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0
const planConfigurationFingerprint = (draft: ManualWorkspaceDraft): string => JSON.stringify({
  selectedModels: [...draft.selectedModels].sort(),
  modelSize: draft.modelSize,
  embeddingMode: draft.embeddingMode,
  parameters: draft.parameters,
})

export const ManualWorkspace = ({
  runId, status, detail, reasoning, events, results, loading, error,
  onCreated, onEnsureProject, onRefresh, activeOperation, draft, onDraftChange, onOperationChange, onConversationMessages,
  onConversationNotice, conversationAttachments = [], conversationMessages = [], capturedActivity,
}: ManualWorkspaceProps): React.ReactElement => {
  const [localBusy, setLocalBusy] = useState<ManualOperationAction>()
  const [actionError, setActionError] = useState<string>()
  const [draftNotice, setDraftNotice] = useState<string>()
  const [workspaces, setWorkspaces] = useState<WebRunWorkspaces>()
  const [overview, setOverview] = useState<DatasetOverview>()
  const [sample, setSample] = useState<DatasetSample>()
  const [models, setModels] = useState<ModelCatalogEntry[]>([])
  const [automaticTrainingFailure, setAutomaticTrainingFailure] = useState<string>()
  const folderInputRef = useRef<HTMLInputElement>(null)
  const captureNoticeKeysRef = useRef(new Set<string>())
  const automaticInspectKeysRef = useRef(new Set<string>())
  const automaticTrainingKeysRef = useRef(new Set<string>())
  const {
    activeStage, pendingFile, primaryTextColumn, timeColumn, metadataColumns,
    cleaning, minimumWords, analysisGoal, deliverable, researchGoal, language,
    selectedModels, modelSize, embeddingMode, parameters,
  } = draft
  const updateDraft = (patch: Partial<ManualWorkspaceDraft>): void => {
    onDraftChange((current) => ({ ...current, ...patch }))
    setDraftNotice(undefined)
  }
  const inheritedBusy = activeOperation?.action
  const busy = localBusy ?? inheritedBusy
  const conversationDataset = conversationAttachments.find((attachment) => attachment.kind === 'dataset')

  useEffect(() => { folderInputRef.current?.setAttribute('webkitdirectory', '') }, [])
  useEffect(() => {
    if (!runId) {
      setWorkspaces(undefined); setOverview(undefined); setSample(undefined)
      return
    }
    let cancelled = false
    void getRunWorkspaces(runId).then((value) => {
      if (cancelled) return
      setWorkspaces(value)
      const roles = value.dataset?.columnRoles ?? []
      const capturedPrimary = primaryTextColumn || roles.find((role) => /primary_text|text/iu.test(role.proposedRole))?.column || ''
      const capturedTime = timeColumn || roles.find((role) => /time/iu.test(role.proposedRole))?.column || ''
      const capturedMetadata = metadataColumns.length ? metadataColumns : roles.filter((role) => /metadata|group|covariate/iu.test(role.proposedRole)).map((role) => role.column)
      onDraftChange((current) => ({
        ...current,
        primaryTextColumn: current.primaryTextColumn || capturedPrimary,
        timeColumn: current.timeColumn || capturedTime,
        metadataColumns: current.metadataColumns.length ? current.metadataColumns : capturedMetadata,
      }))
      const capturedLabels = [
        !primaryTextColumn && capturedPrimary ? `正文列“${capturedPrimary}”` : '',
        !timeColumn && capturedTime ? `时间列“${capturedTime}”` : '',
        metadataColumns.length === 0 && capturedMetadata.length ? `元数据列“${capturedMetadata.join('、')}”` : '',
      ].filter(Boolean)
      const noticeKey = `dataset:${value.dataset?.workspaceHash ?? ''}:${capturedLabels.join('|')}`
      if (capturedLabels.length && !captureNoticeKeysRef.current.has(noticeKey)) {
        captureNoticeKeysRef.current.add(noticeKey)
        onConversationNotice?.(`已从当前数据理解中填入手动工作台配置：${capturedLabels.join('、')}。请检查并保存数据配置。`)
      }
    }).catch((loadError: unknown) => {
      if (!cancelled) setActionError(loadError instanceof Error ? loadError.message : String(loadError))
    })
    return () => { cancelled = true }
  }, [runId, status?.currentState])

  useEffect(() => {
    const captured = {
      research: workspaces?.research,
      intent: reasoning?.researchIntent,
      summary: reasoning?.intentSummary,
      recommendation: reasoning?.recommendation,
      activity: capturedActivity,
      recentUserMessages: conversationMessages.filter((message) => message.role === 'user').slice(-8).map((message) => message.content),
    }
    const patch: Partial<ManualWorkspaceDraft> = {}
    const capturedLabels: string[] = []
    const inferredGoal = inferAnalysisGoal(captured)
    const inferredDelivery = inferDeliverable(captured)
    if (!analysisGoal && inferredGoal) {
      patch.analysisGoal = inferredGoal
      capturedLabels.push(`分析方向“${analysisGoalLabel(inferredGoal)}”`)
    }
    if (!deliverable && inferredDelivery) {
      patch.deliverable = inferredDelivery
      capturedLabels.push(`预期交付“${deliverableLabel(inferredDelivery)}”`)
    }
    if (!researchGoal.trim() && workspaces?.research?.narrative && workspaces.research.narrative.length < 500) {
      patch.researchGoal = workspaces.research.narrative
      capturedLabels.push('研究补充说明')
    }
    let nextSelectedModels = selectedModels
    if (!draft.modelSelectionTouched && selectedModels.length === 0) {
      const recommended = reasoning?.modelChoices?.filter((choice) => choice.recommended).map((choice) => choice.modelId) ?? []
      if (recommended.length) {
        nextSelectedModels = recommended
        patch.selectedModels = recommended
        capturedLabels.push(`候选模型“${recommended.join('、')}”`)
      }
    }
      const configuration = reasoning?.parameterConfiguration
      if (configuration) {
        if (!draft.modelSelectionTouched && nextSelectedModels.length === 0) {
          patch.selectedModels = [configuration.modelId]
          capturedLabels.push(`候选模型“${configuration.modelId}”`)
        }
        const aliases: Record<string, keyof typeof DEFAULT_PARAMETERS> = {
          vocabularysize: 'vocabularySize', vocabulary_size: 'vocabularySize', vocab_size: 'vocabularySize',
          topiccount: 'topicCount', topic_count: 'topicCount', num_topics: 'topicCount',
          epochs: 'epochs', training_epochs: 'epochs', batchsize: 'batchSize', batch_size: 'batchSize',
          learningrate: 'learningRate', learning_rate: 'learningRate', hiddensize: 'hiddenSize', hidden_size: 'hiddenSize',
          earlystopping: 'earlyStopping', early_stopping: 'earlyStopping', patience: 'earlyStopping',
        }
        if (!draft.parametersTouched) {
          const merged = { ...parameters }
          const changedParameters: string[] = []
          for (const parameter of configuration.parameters) {
            const normalized = parameter.field.replace(/[\s-]/gu, '_').toLowerCase()
            const key = aliases[normalized] ?? aliases[normalized.replace(/_/gu, '')]
            const numeric = Number(parameter.value)
            if (key && finitePositive(numeric) && merged[key] !== numeric) {
              merged[key] = numeric
              changedParameters.push(parameter.field)
            }
          }
          if (changedParameters.length) {
            patch.parameters = merged
            capturedLabels.push(`训练参数 ${changedParameters.join('、')}`)
          }
        }
      }
    if (Object.keys(patch).length === 0) return
    onDraftChange((current) => ({ ...current, ...patch }))
    const noticeKey = `capture:${JSON.stringify(patch)}`
    if (!captureNoticeKeysRef.current.has(noticeKey)) {
      captureNoticeKeysRef.current.add(noticeKey)
      onConversationNotice?.(`已从当前项目对话中识别并填入手动工作台配置：${capturedLabels.join('、')}。参数完整后阶段会自动标记完成；若在手动工作台修改，请点击对应保存按钮。`)
    }
  }, [analysisGoal, capturedActivity, conversationMessages, deliverable, draft.modelSelectionTouched, draft.parametersTouched, onConversationNotice, onDraftChange, parameters, reasoning, researchGoal, selectedModels, workspaces?.research?.workspaceHash])

  const execute = async (action: ManualOperationAction, operation: () => Promise<void>, completionDetail?: string): Promise<boolean> => {
    if (busy) return false
    const progress: ManualOperationStatus = {
      id: crypto.randomUUID(),
      runId,
      action,
      ...OPERATION_COPY[action],
      startedAt: new Date().toISOString(),
      state: 'running',
    }
    setLocalBusy(action); setActionError(undefined); onOperationChange?.(progress)
    try {
      await operation()
      onOperationChange?.({ ...progress, state: 'completed', completedAt: new Date().toISOString(), completionDetail })
      return true
    } catch (operationError) {
      const detail = operationError instanceof Error ? operationError.message : String(operationError)
      setActionError(detail)
      onOperationChange?.({ ...progress, state: 'failed', completedAt: new Date().toISOString(), error: detail })
      return false
    } finally {
      setLocalBusy(undefined)
    }
  }

  const inspectDataset = (): void => { void execute('inspect', async () => {
    if (!runId) return
    const overviewResult = await invokeRunTool<{ analysis?: DatasetOverview }>(runId, 'theta.dataset.overview')
    const nextOverview = overviewResult.output.analysis ?? overviewResult.output as DatasetOverview
    setOverview(nextOverview)
    onDraftChange((current) => ({ ...current, primaryTextColumn: current.primaryTextColumn || nextOverview.candidateRoles?.text?.[0]?.name || nextOverview.columns?.[0] || '' }))
    try {
      const sampleResult = await invokeRunTool<DatasetSample>(runId, 'theta.dataset.sample', { sampleSize: 5 })
      setSample(sampleResult.output)
    } catch { setSample(undefined) }
    onRefresh()
  }) }

  const createFromFile = (): void => { void execute('upload', async () => {
    if (!pendingFile && !conversationDataset) throw new Error('请先选择数据集文件。')
    const suggestedName = pendingFile?.name.replace(/\.[^.]+$/u, '') || conversationDataset?.label || '新分析项目'
    const projectId = await onEnsureProject(suggestedName)
    const datasetRef = pendingFile ? (await uploadDataset(projectId, pendingFile)).datasetRef : conversationDataset?.id
    if (!datasetRef) throw new Error('未取得可用的数据集引用。')
    const created = await createRun({
      projectId, datasetRef, allowRemoteSamples: true,
      ...(researchSummary(draft) ? { researchGoal: researchSummary(draft) } : {}),
    })
    onDraftChange((current) => ({ ...current, pendingFile: undefined }))
    onCreated(created.runId, researchSummary(draft) || pendingFile?.name.replace(/\.[^.]+$/u, '') || conversationDataset?.label)
  }) }

  const saveDatasetConfiguration = (): void => { void execute('dataset', async () => {
    if (!runId || !primaryTextColumn) throw new Error('必须选择一个正文列。')
    const clean = CLEANING_OPTIONS.filter(([key]) => cleaning[key]).map(([, label]) => label)
    const result = await postMessage(runId, [
      '手动工作台提交数据配置，请使用当前 Run 的数据集 tools 写入同一份 DatasetWorkspace：',
      `正文列：${primaryTextColumn}`, `时间列：${timeColumn || '无'}`,
      `标签/元数据列：${metadataColumns.length ? metadataColumns.join('、') : '无'}`,
      `清洗要求：${clean.join('、') || '不执行额外清洗'}`, `最小词数：${minimumWords}`,
      '这些是用户的明确选择，请不要替换数据集；更新完成后给出可确认的数据理解。',
    ].join('\n'), true)
    onConversationMessages?.(runId, result.messages)
    setWorkspaces(await getRunWorkspaces(runId)); onRefresh()
  }, `数据配置已保存：正文列“${primaryTextColumn}”${timeColumn ? `，时间列“${timeColumn}”` : ''}，最小词数 ${minimumWords}。`) }

  const submitResearch = (): void => {
    if (!analysisGoal || !deliverable) { setActionError('请选择分析方向和预期交付形式。'); return }
    if (!runId) { setActionError(undefined); setDraftNotice('研究设置已保存到当前项目草稿，创建任务后会自动带入。'); return }
    void execute('research-save', async () => {
    const result = await postMessage(runId, [
      '手动工作台提交结构化研究设置：',
      `分析方向：${analysisGoalLabel(analysisGoal)}。`,
      `预期交付形式：${deliverableLabel(deliverable)}。`,
      `数据语言：${language === 'zh' ? '中文' : 'English'}。`,
      ...(researchGoal.trim() ? [`补充说明：${researchGoal.trim()}。`] : []),
      '请将这些明确选项写入当前 ResearchWorkspace；如仍有关键问题，请在右侧对话中继续询问。',
    ].join('\n\n'), true)
    onConversationMessages?.(runId, result.messages)
    setWorkspaces(await getRunWorkspaces(runId)); onRefresh()
    }, `研究设置已保存：分析方向“${analysisGoalLabel(analysisGoal)}”，预期交付“${deliverableLabel(deliverable)}”。`)
  }

  const loadModels = (): void => {
    if (!runId) {
      setModels(DRAFT_MODEL_CATALOG)
      return
    }
    void execute('models', async () => {
    const result = await invokeRunTool<{ models?: ModelCatalogEntry[] }>(runId, 'theta.model.catalog')
    const available = (result.output.models ?? []).filter((model) => model.runnable !== false)
    setModels(available)
    })
  }

  const submitPlan = (): void => {
    if (selectedModels.length === 0) { setActionError('至少选择一个模型。'); return }
    const savedFingerprint = planConfigurationFingerprint(draft)
    const completionDetail = `模型与参数已经配置：${selectedModels.join('、')}；主题数 ${parameters.topicCount}；训练轮数 ${parameters.epochs}；批大小 ${parameters.batchSize}。`
    if (!runId) {
      void execute('plan', async () => {
        updateDraft({ savedPlanFingerprint: savedFingerprint })
        setDraftNotice('模型与参数已保存到当前项目草稿，创建任务后可提交校验。')
      }, completionDetail)
      return
    }
    void execute('plan', async () => {
    const result = await postMessage(runId, [
      '手动工作台提交模型与训练配置，请通过当前 Run 的规划 tools 创建或修订候选计划：',
      `数据语言：${language === 'zh' ? '中文' : 'English'}`, `候选模型：${selectedModels.join('、')}`,
      `THETA 模型尺寸：${modelSize}`, `嵌入模式：${embeddingMode}`,
      `全局词汇表大小：${parameters.vocabularySize}`, `主题数：${parameters.topicCount}`,
      `训练轮数：${parameters.epochs}`, `批大小：${parameters.batchSize}`,
      `学习率：${parameters.learningRate}`, `隐藏层维度：${parameters.hiddenSize}`,
      `Early Stopping 耐心值：${parameters.earlyStopping}`,
      '请校验模型能力、参数合法范围和当前数据适配性；不要绕过计划确认与训练审批。',
    ].join('\n'), true)
    onConversationMessages?.(runId, result.messages)
    updateDraft({ savedPlanFingerprint: savedFingerprint })
    onRefresh()
    }, completionDetail)
  }

  const advance = (action: 'discover' | 'research' | 'plan-design' | 'prepare-training' | 'advance-training'): void => {
    if (!runId) { setActionError('该执行操作需要先上传数据并创建任务；当前阶段填写的内容已保留在项目草稿中。'); return }
    void execute(action, async () => { await runWorkflowAction(runId, action); onRefresh() })
  }
  const cancelTraining = (): void => { void execute('cancel', async () => {
    if (runId) { await cancelRunTraining(runId, '用户从手动工作台取消当前训练。'); onRefresh() }
  }) }

  const identity = detail?.identity ?? {}
  const datasetBound = Boolean(status?.datasetRef)
  const dataComplete = Boolean(datasetBound && primaryTextColumn && finitePositive(minimumWords))
  const researchComplete = Boolean(analysisGoal && deliverable && language)
  const planFieldsComplete = Boolean(selectedModels.length && modelSize && embeddingMode && Object.values(parameters).every(finitePositive))
  const planCapturedFromConversation = Boolean(reasoning?.parameterConfiguration || reasoning?.modelChoices?.some((choice) => choice.recommended))
  const planSaved = draft.savedPlanFingerprint === planConfigurationFingerprint(draft)
  const planComplete = Boolean(planFieldsComplete && (planSaved || (planCapturedFromConversation && !draft.modelSelectionTouched && !draft.parametersTouched)))
  const trainingComplete = status?.status === 'completed' || status?.trainingStatus === 'completed'
  const resultsComplete = Boolean(results && (Object.keys(results.metrics).length || results.topics.length || results.visualizations.length))
  const prerequisitesComplete = dataComplete && researchComplete && planComplete

  useEffect(() => {
    if (!runId || !datasetBound || overview || busy != null) return
    const key = `${runId}:${status?.datasetRef ?? ''}:${status?.datasetHash ?? ''}`
    if (automaticInspectKeysRef.current.has(key)) return
    automaticInspectKeysRef.current.add(key)
    const timer = window.setTimeout(inspectDataset, 0)
    return () => window.clearTimeout(timer)
  }, [busy, datasetBound, overview, runId, status?.datasetHash, status?.datasetRef])

  useEffect(() => {
    if (!runId || !prerequisitesComplete || busy != null) return
    const currentState = status?.currentState ?? ''
    const step = automaticTrainingStep(currentState)
    if (!step) return
    const key = `${runId}:${currentState}:${status?.datasetHash ?? ''}:${planConfigurationFingerprint(draft)}`
    if (automaticTrainingKeysRef.current.has(key)) return
    automaticTrainingKeysRef.current.add(key)
    setAutomaticTrainingFailure(undefined)
    const timer = window.setTimeout(() => {
      void execute(step.operation, async () => {
        await runWorkflowAction(runId, step.action)
        onRefresh()
      }, step.completionDetail).then((succeeded) => {
        if (!succeeded) setAutomaticTrainingFailure(currentState)
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [busy, draft, onRefresh, prerequisitesComplete, runId, status?.currentState, status?.datasetHash])

  const retryAutomaticTrainingPreparation = (): void => {
    if (!runId) return
    const currentState = status?.currentState ?? ''
    const step = automaticTrainingStep(currentState)
    if (!step) return
    setAutomaticTrainingFailure(undefined)
    void execute(step.operation, async () => {
      await runWorkflowAction(runId, step.action)
      onRefresh()
    }, step.completionDetail).then((succeeded) => {
      if (!succeeded) setAutomaticTrainingFailure(currentState)
    })
  }

  const stageCompletion: Record<ManualStage, boolean> = {
    data: dataComplete, research: researchComplete, plan: planComplete,
    training: trainingComplete, results: resultsComplete,
  }

  return <section className={css.manualWorkspace}>
    <nav className={css.manualStages} aria-label="研究阶段">
      {STAGES.map((stage) => {
        const Icon = stage.icon
        const complete = stageCompletion[stage.id]
        return <button key={stage.id} type="button" className={`${stage.id === activeStage ? css.manualStageActive : ''} ${complete ? css.manualStageCompleted : ''}`} onClick={() => updateDraft({ activeStage: stage.id })}>
          <span className={complete ? css.manualStageComplete : undefined}>{complete ? <IconCheckOutline16 /> : <Icon />}</span>
          <strong>{stage.label}</strong><small>{complete ? '配置完整' : stage.id === activeStage ? '正在补充' : '待补充'}</small>
        </button>
      })}
    </nav>
    {runId && <header className={css.manualHeader}>
      <div><small>{status?.presentation?.title ?? 'THETA 研究任务'}</small><h1>{stringValue(identity, 'displayName') ?? stringValue(identity, 'datasetName') ?? runId}</h1><code>{runId}</code></div>
      <div className={css.manualHeaderActions}>
        <span className={status?.pendingReason ? css.manualNeedsInput : css.manualRunning}>{status?.pendingReason ? '等待你的操作' : statusLabel(status?.status)}</span>
        <button type="button" onClick={onRefresh} disabled={loading || busy != null} aria-label="刷新任务"><IconRefreshOutline16 className={loading ? css.manualSpin : undefined} /></button>
      </div>
    </header>}
    <div className={css.manualContent}>
      <div className={css.manualFlowNotice}>各阶段可独立补充并随时切换；数据检查、方案执行和训练启动时，THETA 才会校验对应前置条件。</div>
      {activeOperation?.state === 'running' && (
        <div className={css.manualOperationBanner} role="status" aria-live="polite">
          <span className={css.activitySpinner} />
          <span className={css.manualOperationText}>
            <strong>{activeOperation.label}</strong>
            <small>{activeOperation.detail}</small>
          </span>
          <span className={css.operationProgressTrack} aria-hidden="true"><i /></span>
        </div>
      )}
      {runId && status?.interaction != null && <ApprovalPanel runId={runId} interaction={status.interaction} reasoning={reasoning} onApproved={onRefresh} />}
      {activeStage === 'data' && (!runId || !datasetBound
        ? <DatasetUploadStage pendingFile={pendingFile} capturedDataset={conversationDataset} busy={busy === 'upload'} folderInputRef={folderInputRef} onFile={(file) => updateDraft({ pendingFile: file })} onUpload={createFromFile} />
        : <DataStage status={status} workspace={workspaces?.dataset} overview={overview} sample={sample} busy={busy != null} inspecting={busy === 'inspect'} primaryTextColumn={primaryTextColumn} timeColumn={timeColumn} metadataColumns={metadataColumns} cleaning={cleaning} minimumWords={minimumWords} onPrimaryTextColumn={(value) => updateDraft({ primaryTextColumn: value })} onTimeColumn={(value) => updateDraft({ timeColumn: value })} onMetadataColumns={(value) => updateDraft({ metadataColumns: value })} onCleaning={(value) => updateDraft({ cleaning: value })} onMinimumWords={(value) => updateDraft({ minimumWords: value })} onSave={saveDatasetConfiguration} onAdvance={() => advance('discover')} />)}
      {activeStage === 'research' && <ResearchStage runAvailable={Boolean(runId)} workspace={workspaces?.research} pendingReason={status?.pendingReason} analysisGoal={analysisGoal} deliverable={deliverable} notes={researchGoal} language={language} busy={busy != null} onAnalysisGoal={(value) => updateDraft({ analysisGoal: value })} onDeliverable={(value) => updateDraft({ deliverable: value })} onNotes={(value) => updateDraft({ researchGoal: value })} onLanguage={(value) => updateDraft({ language: value })} onSubmit={submitResearch} onAdvance={() => advance('research')} />}
      {activeStage === 'plan' && <PlanStage runAvailable={Boolean(runId)} dataComplete={dataComplete} researchComplete={researchComplete} reasoning={reasoning} plan={detail?.plan} models={models.length ? models : DRAFT_MODEL_CATALOG} selectedModels={selectedModels} modelSize={modelSize} embeddingMode={embeddingMode} parameters={parameters} busy={busy != null} onModels={(value) => updateDraft({ selectedModels: value, modelSelectionTouched: true })} onModelSize={(value) => updateDraft({ modelSize: value, parametersTouched: true })} onEmbeddingMode={(value) => updateDraft({ embeddingMode: value, parametersTouched: true })} onParameters={(value) => updateDraft({ parameters: value, parametersTouched: true })} onLoadModels={loadModels} onSubmit={submitPlan} onAdvance={() => advance('plan-design')} />}
      {activeStage === 'training' && <TrainingStage runAvailable={Boolean(runId)} prerequisitesComplete={prerequisitesComplete} status={status} events={events} busy={busy != null} preparing={Boolean(busy && ['discover', 'research', 'plan-design', 'prepare-training', 'advance-training'].includes(busy))} automaticFailure={automaticTrainingFailure === status?.currentState} onRetryPreparation={retryAutomaticTrainingPreparation} onAdvance={() => advance('advance-training')} onCancel={cancelTraining} />}
      {activeStage === 'results' && <ResultsStage results={results} />}
      {(error ?? actionError) != null && <div className={css.manualError} role="alert">{error ?? actionError}</div>}
      {draftNotice && <div className={css.manualDraftNotice} role="status">{draftNotice}</div>}
    </div>
  </section>
}

const DatasetUploadStage = ({ pendingFile, capturedDataset, busy, folderInputRef, onFile, onUpload }: {
  pendingFile?: File; capturedDataset?: WebAttachment; busy: boolean; folderInputRef: React.RefObject<HTMLInputElement | null>
  onFile: (file?: File) => void; onUpload: () => void
}): React.ReactElement => <StageSection title="上传数据" description="建立当前项目的研究 Run">
  <div className={css.manualUploadNotice}>CSV 可配置文本列和清洗选项；其他文本格式由后端提取可分析内容。</div>
  <div className={css.manualDropzone} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onFile(event.dataTransfer.files[0]) }}>
    <IconDataOutline16 /><strong>{pendingFile?.name ?? capturedDataset?.label ?? '拖拽文件或文件夹到此处'}</strong>{pendingFile && <small>{readableBytes(pendingFile.size)}</small>}
    <div>
      <label><IconDataOutline16 />选择文件<input type="file" accept=".csv,.tsv,.json,.jsonl,.txt,.md,.xlsx,.xls,.parquet,.pdf,.doc,.docx" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; onFile(file) }} /></label>
      <label><IconFolderOpenOutline16 />选择文件夹<input ref={folderInputRef} type="file" multiple onChange={(event) => { const file = Array.from(event.target.files ?? []).find((item) => /\.(csv|tsv|jsonl?|txt|md|xlsx?|parquet)$/iu.test(item.name)); event.currentTarget.value = ''; onFile(file) }} /></label>
      {pendingFile && <button type="button" className={css.manualFileRemove} disabled={busy} onClick={() => onFile(undefined)}><IconTrashOutline16 />移除数据集</button>}
    </div><small>CSV、TSV、JSON、JSONL、TXT、Markdown、Excel、Parquet</small>
  </div>
  {capturedDataset && !pendingFile && <div className={css.manualDraftNotice}>已采用右侧对话中上传的数据集：{capturedDataset.label}</div>}
  <DependencyNotice>创建任务后需完成“数据管理”环节的“正文列与清洗配置”，该阶段才会标记为完成。</DependencyNotice>
  <div className={css.manualSectionActions}><Button variant="primary" disabled={(!pendingFile && !capturedDataset) || busy} onClick={onUpload}>{busy ? '正在创建…' : '使用数据集创建任务'}</Button></div>
</StageSection>

const DataStage = ({ status, workspace, overview, sample, busy, inspecting, primaryTextColumn, timeColumn, metadataColumns, cleaning, minimumWords, onPrimaryTextColumn, onTimeColumn, onMetadataColumns, onCleaning, onMinimumWords, onSave, onAdvance }: {
  status?: WebRunStatus; workspace?: WebRunWorkspaces['dataset']; overview?: DatasetOverview; sample?: DatasetSample; busy: boolean; inspecting: boolean
  primaryTextColumn: string; timeColumn: string; metadataColumns: string[]; cleaning: CleaningState; minimumWords: number
  onPrimaryTextColumn: (value: string) => void; onTimeColumn: (value: string) => void; onMetadataColumns: (value: string[]) => void
  onCleaning: (value: CleaningState) => void; onMinimumWords: (value: number) => void
  onSave: () => void; onAdvance: () => void
}): React.ReactElement => <StageSection title="数据管理" description="数据结构、字段角色和清洗规则">
  <div className={css.manualMetrics}>
    <Metric label="数据集" value={overview?.fileName ?? status?.datasetRef ?? '已绑定'} />
    <Metric label="记录数" value={overview?.rowCount != null ? overview.rowCount.toLocaleString() : '等待检查'} />
    <Metric label="字段数" value={overview?.columns?.length != null ? String(overview.columns.length) : String(workspace?.columnRoles.length ?? '等待检查')} />
  </div>
  <div className={css.manualSectionActions}>
    <Button variant="primary" disabled={busy || !overview || !primaryTextColumn} onClick={onSave}><IconSettingsOutline16 />保存数据配置</Button>
    <Button variant="ghost" disabled={busy || !primaryTextColumn} onClick={onAdvance}><IconPlayOutline16 />运行数据检查</Button>
  </div>
  {!overview ? <DependencyNotice>{inspecting ? 'THETA 正在自动读取数据结构与预览，完成前已暂停本环节的其他操作。' : '数据集绑定后，THETA 会自动读取结构与预览；完成后即可配置正文列与清洗规则。'}</DependencyNotice> : <DataConfigurationFields overview={overview} sample={sample} primaryTextColumn={primaryTextColumn} timeColumn={timeColumn} metadataColumns={metadataColumns} cleaning={cleaning} minimumWords={minimumWords} onPrimaryTextColumn={onPrimaryTextColumn} onTimeColumn={onTimeColumn} onMetadataColumns={onMetadataColumns} onCleaning={onCleaning} onMinimumWords={onMinimumWords} />}
  {workspace && <div className={css.manualNarrative}>
    <small>当前数据理解 · 修订 {workspace.revision}</small>
    <p>{datasetNarrative(workspace.narrative)}</p>
    {inspecting && (
      <span className={css.manualNarrativeRunning}><span className={css.activitySpinner} />THETA 正在自动读取结构与预览…</span>
    )}
  </div>}
  {!overview && (sample?.sampleRows?.length ? <PreviewTable rows={sample.sampleRows} /> : <EmptyLine>读取结构后显示受治理的数据预览。</EmptyLine>)}
</StageSection>

const ResearchStage = ({ runAvailable, workspace, pendingReason, analysisGoal, deliverable, notes, language, busy, onAnalysisGoal, onDeliverable, onNotes, onLanguage, onSubmit, onAdvance }: {
  runAvailable: boolean; workspace?: WebRunWorkspaces['research']; pendingReason?: string
  analysisGoal: AnalysisGoal; deliverable: Deliverable; notes: string; language: 'zh' | 'en'; busy: boolean
  onAnalysisGoal: (value: AnalysisGoal) => void; onDeliverable: (value: Deliverable) => void; onNotes: (value: string) => void
  onLanguage: (value: 'zh' | 'en') => void; onSubmit: () => void; onAdvance: () => void
}): React.ReactElement => {
  const openQuestions = workspace?.questions.filter((question) => question.status === 'open') ?? []
  const waitingForAnswer = openQuestions.some((question) => question.blocking) || Boolean(pendingReason)
  const normalizeQuestion = (question: string): string => question.replace(/[\s，。！？、；：,.!?;:]/gu, '')
  const normalizedPendingReason = pendingReason ? normalizeQuestion(pendingReason) : ''
  const pendingAlreadyListed = openQuestions.some((question) => question.blocking) ||
    (normalizedPendingReason.length > 0 && openQuestions.some((question) => {
      const normalizedQuestion = normalizeQuestion(question.question)
      return normalizedQuestion === normalizedPendingReason ||
        normalizedQuestion.includes(normalizedPendingReason) ||
        normalizedPendingReason.includes(normalizedQuestion)
    }))
  return <StageSection title="研究设置" description="研究目标、语言和分析边界">
    <div className={css.manualChoiceRow}><strong>数据语言</strong><label><input type="radio" checked={language === 'zh'} onChange={() => onLanguage('zh')} />中文</label><label><input type="radio" checked={language === 'en'} onChange={() => onLanguage('en')} />English</label></div>
    <fieldset className={css.manualStructuredGroup}><legend>分析方向（必选）</legend><div className={css.manualChoiceCards}>{ANALYSIS_GOALS.map((item) => <label key={item.id} className={analysisGoal === item.id ? css.manualChoiceSelected : undefined}><input type="radio" name="analysis-goal" checked={analysisGoal === item.id} onChange={() => onAnalysisGoal(item.id)} /><span><strong>{item.label}</strong><small>{item.description}</small></span></label>)}</div></fieldset>
    <fieldset className={css.manualStructuredGroup}><legend>预期交付形式（必选）</legend><div className={css.manualOptionGrid}>{DELIVERABLES.map((item) => <label key={item.id}><input type="radio" name="deliverable" checked={deliverable === item.id} onChange={() => onDeliverable(item.id)} />{item.label}</label>)}</div></fieldset>
    <label className={css.manualField}><span>补充说明（可选）</span><textarea rows={2} value={notes} onChange={(event) => onNotes(event.target.value)} placeholder={pendingReason ?? '可补充研究边界、关注对象或特殊要求'} /></label>
    {(openQuestions.length > 0 || (pendingReason && !pendingAlreadyListed)) && <div className={css.manualRows}>
      {openQuestions.map((question) => <div key={question.id}><span>{question.blocking ? '需要确认' : '可选'}</span><strong>{question.question}</strong><p>{question.whyItMatters}</p></div>)}
      {pendingReason && !pendingAlreadyListed && <div><span>需要确认</span><strong>{pendingReason}</strong><p>请在上方填写回答并保存，THETA 将基于你的回答继续推进。</p></div>}
    </div>}
    <div className={css.manualSectionActions}>
      <Button variant="ghost" disabled={busy || waitingForAnswer || !runAvailable} onClick={onAdvance}>{!runAvailable ? '创建任务后由 THETA 梳理' : waitingForAnswer ? '等待你补充确认' : '让 THETA 梳理研究问题'}</Button>
      <Button variant="primary" disabled={busy || !analysisGoal || !deliverable} onClick={onSubmit}>{!runAvailable ? '保存结构化设置' : '保存研究设置'}</Button>
    </div>
  </StageSection>
}

const PlanStage = ({ runAvailable, dataComplete, researchComplete, reasoning, plan, models, selectedModels, modelSize, embeddingMode, parameters, busy, onModels, onModelSize, onEmbeddingMode, onParameters, onLoadModels, onSubmit, onAdvance }: {
  runAvailable: boolean; dataComplete: boolean; researchComplete: boolean; reasoning?: WebReasoning; plan?: Record<string, unknown>
  models: ModelCatalogEntry[]; selectedModels: string[]; modelSize: ModelSize; embeddingMode: EmbeddingMode; parameters: typeof DEFAULT_PARAMETERS; busy: boolean
  onModels: (value: string[]) => void; onModelSize: (value: ModelSize) => void; onEmbeddingMode: (value: EmbeddingMode) => void
  onParameters: (value: typeof DEFAULT_PARAMETERS) => void; onLoadModels: () => void; onSubmit: () => void; onAdvance: () => void
}): React.ReactElement => {
  const configuration = reasoning?.parameterConfiguration
  const prerequisitesComplete = dataComplete && researchComplete
  return <StageSection title="模型与参数" description="模型选择、训练参数和方案验证">
    {reasoning?.modelChoices?.length ? <div className={css.manualModelGrid}>{reasoning.modelChoices.map((choice) => <article key={choice.modelId} className={choice.recommended ? css.manualModelRecommended : undefined}><div><strong>{choice.modelId.toUpperCase()}</strong>{choice.recommended && <span>推荐</span>}</div><p>{choice.rationale}</p><small>{choice.tradeoffs.join('；')}</small></article>)}</div> : <EmptyLine>{models.length ? `已读取 ${models.length} 个可运行模型。` : '模型建议尚未生成。'}</EmptyLine>}
    {configuration && <div className={css.manualParameterTable}><header><strong>{configuration.modelId.toUpperCase()}</strong><span>当前参数</span></header>{configuration.parameters.map((parameter) => <div key={parameter.field}><strong>{parameter.field}</strong><code>{String(parameter.value)}</code><span>{parameter.rationale}</span></div>)}</div>}
    <fieldset className={css.manualStructuredGroup}><legend>选择模型（可多选，必选）</legend><div className={css.manualModelOptions}>{models.map((model) => <label key={model.id}><input type="checkbox" checked={selectedModels.includes(model.id)} onChange={(event) => onModels(event.target.checked ? [...selectedModels, model.id] : selectedModels.filter((id) => id !== model.id))} /><span><strong>{model.name || model.id.toUpperCase()}</strong><small>{model.type}{model.experimental ? ' · 实验性' : ''}</small></span></label>)}</div></fieldset>
    <div className={css.manualThetaConfig}>
      <h3>THETA 专属配置</h3>
      <fieldset><legend>Qwen 模型尺寸</legend><div className={css.manualChoiceRow}>{(['0.6B', '4B', '8B'] as ModelSize[]).map((value) => <label key={value}><input type="radio" name="model-size" checked={modelSize === value} onChange={() => onModelSize(value)} />{value}{value === '0.6B' ? '（默认）' : ''}</label>)}</div></fieldset>
      <fieldset><legend>嵌入模式</legend><div className={css.manualChoiceRow}>{([['zero-shot', 'Zero-shot（默认）'], ['unsupervised', 'Unsupervised'], ['supervised', 'Supervised']] as Array<[EmbeddingMode, string]>).map(([value, label]) => <label key={value}><input type="radio" name="embedding-mode" checked={embeddingMode === value} onChange={() => onEmbeddingMode(value)} />{label}</label>)}</div></fieldset>
      <label className={css.manualField}><span>全局词汇表大小</span><input type="number" min={1000} max={100000} value={parameters.vocabularySize} onChange={(event) => onParameters({ ...parameters, vocabularySize: Number(event.target.value) })} /></label>
      <div className={css.manualParameterEditor}>
        <NumberField label="主题数" min={5} max={100} value={parameters.topicCount} onChange={(value) => onParameters({ ...parameters, topicCount: value })} />
        <NumberField label="训练轮数" min={10} max={500} value={parameters.epochs} onChange={(value) => onParameters({ ...parameters, epochs: value })} />
        <NumberField label="批大小" min={1} max={1024} value={parameters.batchSize} onChange={(value) => onParameters({ ...parameters, batchSize: value })} />
        <NumberField label="学习率" min={0.000001} max={1} step={0.0001} value={parameters.learningRate} onChange={(value) => onParameters({ ...parameters, learningRate: value })} />
        <NumberField label="隐藏层维度" min={16} max={4096} value={parameters.hiddenSize} onChange={(value) => onParameters({ ...parameters, hiddenSize: value })} />
        <NumberField label="Early Stopping 耐心值" min={1} max={100} value={parameters.earlyStopping} onChange={(value) => onParameters({ ...parameters, earlyStopping: value })} />
      </div>
    </div>
    {!prerequisitesComplete && <DependencyNotice>“生成候选方案”需要“数据管理”环节的“正文列与清洗配置”和“研究设置”环节的“分析方向与交付形式”完成后才可继续。</DependencyNotice>}
    {plan && <div className={css.manualHash}>方案已写入当前 Run</div>}
    <div className={css.manualSectionActions}><Button variant="ghost" disabled={busy} onClick={onLoadModels}><IconRefreshOutline16 />同步可用模型</Button><Button variant="ghost" disabled={busy || !runAvailable || !prerequisitesComplete} onClick={onAdvance}>{runAvailable ? '生成候选方案' : '创建任务后生成方案'}</Button><Button variant="primary" disabled={busy || selectedModels.length === 0} onClick={onSubmit}>保存模型与参数</Button></div>
  </StageSection>
}

const TrainingStage = ({ runAvailable, prerequisitesComplete, status, events, busy, preparing, automaticFailure, onRetryPreparation, onAdvance, onCancel }: {
  runAvailable: boolean; prerequisitesComplete: boolean; status?: WebRunStatus; events: WebRunEvent[]; busy: boolean
  preparing: boolean; automaticFailure: boolean; onRetryPreparation: () => void; onAdvance: () => void; onCancel: () => void
}): React.ReactElement => {
  const progress = status?.presentation?.progress
  const trainingEvents = events.filter((event) => /training|训练/iu.test(`${event.type} ${event.title}`)).slice(-12)
  const running = ['queued', 'running', 'cancel_requested'].includes(status?.trainingStatus ?? '')
  const readyToStart = status?.currentState === 'StartTraining'
  const confirmationCopy = TRAINING_CONFIRMATION_COPY[status?.currentState ?? '']
  return <StageSection title="模型训练" description="配置检查、训练审批和运行进度">
    <div className={css.manualProgress}><div><strong>{progress?.label ?? status?.presentation?.summary ?? '等待训练'}</strong><span>{progress?.percent ?? 0}%</span></div><span><i style={{ width: `${Math.max(0, Math.min(100, progress?.percent ?? 0))}%` }} /></span></div>
    {!prerequisitesComplete && <DependencyNotice>“模型训练”需要“数据管理”“研究设置”和“模型与参数”三个环节的必填配置全部完成后才可继续。</DependencyNotice>}
    {preparing && <div className={css.manualNarrativeRunning} role="status"><span className={css.activitySpinner} />THETA 正在按当前 Run 的状态完成数据理解、研究梳理、方案生成和训练前校验；完成前不会启动模型训练。</div>}
    {!preparing && prerequisitesComplete && !readyToStart && !running && <DependencyNotice>{confirmationCopy ?? 'THETA 将自动准备训练计划并校验前置条件；只有“启动模型训练”需要你明确点击。'}</DependencyNotice>}
    <div className={css.manualSectionActions}>
      {automaticFailure && <Button variant="ghost" disabled={busy || !runAvailable} onClick={onRetryPreparation}><IconRefreshOutline16 />重试当前准备步骤</Button>}
      {(readyToStart || running) && <Button variant="primary" disabled={busy || !runAvailable || !prerequisitesComplete} onClick={onAdvance}>{running ? '刷新训练状态' : '启动模型训练'}</Button>}
      {running && <Button variant="ghost" disabled={busy} onClick={onCancel}><IconTrashOutline16 />取消训练</Button>}
    </div>
    {trainingEvents.length ? <div className={css.manualTimeline}>{trainingEvents.map((event) => <div key={event.id}><time>{formatTime(event.timestamp)}</time><strong>{event.title}</strong><span>{event.detail}</span></div>)}</div> : <EmptyLine>{runAvailable ? '训练启动后显示受审计的运行事件。' : '可先在模型与参数阶段保存配置；创建任务后再执行训练。'}</EmptyLine>}
  </StageSection>
}

const ResultsStage = ({ results }: { results?: WebRunResults }): React.ReactElement => {
  const metrics = Object.entries(results?.metrics ?? {})
  return <StageSection title="结果分析" description="模型指标、主题结果和可视化产物">
    {metrics.length ? <div className={css.manualMetrics}>{metrics.slice(0, 8).map(([key, value]) => <Metric key={key} label={key} value={String(value)} />)}</div> : <EmptyLine>训练完成后显示评价指标。</EmptyLine>}
    {results?.topics.length ? <div className={css.manualRows}>{results.topics.slice(0, 12).map((topic) => <div key={topic.id}><span>主题 {topic.id}</span><strong>{topic.name}</strong><p>{topic.keywords.join('、')}</p></div>)}</div> : null}
    {results?.visualizations.length ? <div className={css.manualArtifacts}>{results.visualizations.map((item) => <span key={item.id}>{item.label}</span>)}</div> : null}
  </StageSection>
}

const DataConfigurationFields = ({ overview, sample, primaryTextColumn, timeColumn, metadataColumns, cleaning, minimumWords, onPrimaryTextColumn, onTimeColumn, onMetadataColumns, onCleaning, onMinimumWords }: {
  overview?: DatasetOverview; sample?: DatasetSample; primaryTextColumn: string; timeColumn: string; metadataColumns: string[]; cleaning: CleaningState; minimumWords: number
  onPrimaryTextColumn: (value: string) => void; onTimeColumn: (value: string) => void; onMetadataColumns: (value: string[]) => void; onCleaning: (value: CleaningState) => void; onMinimumWords: (value: number) => void
}): React.ReactElement => {
  const columns = overview?.columns ?? []
  return <div className={`${css.manualDialogBody} ${css.manualInlineConfiguration}`}>
      <div className={css.manualConfigurationHeading}><strong>列选择与清洗</strong><small>明确配置文本列、可选元数据列和清洗规则。</small></div>
      <fieldset><legend>文本列（必选）</legend><div className={css.manualOptionGrid}>{columns.map((column) => <label key={column}><input type="radio" name="primary-text" checked={primaryTextColumn === column} onChange={() => onPrimaryTextColumn(column)} />{column}</label>)}</div></fieldset>
      <fieldset><legend>时间列（可选）</legend><select value={timeColumn} onChange={(event) => onTimeColumn(event.target.value)}><option value="">不使用时间列</option>{columns.filter((column) => column !== primaryTextColumn).map((column) => <option key={column}>{column}</option>)}</select></fieldset>
      <fieldset><legend>标签/元数据列（可选）</legend><div className={css.manualOptionGrid}>{columns.filter((column) => column !== primaryTextColumn).map((column) => <label key={column}><input type="checkbox" checked={metadataColumns.includes(column)} onChange={(event) => onMetadataColumns(event.target.checked ? [...metadataColumns, column] : metadataColumns.filter((item) => item !== column))} />{column}</label>)}</div></fieldset>
      <div><strong>前 5 行预览</strong>{sample?.sampleRows?.length ? <PreviewTable rows={sample.sampleRows.slice(0, 5)} /> : <EmptyLine>样本预览未授权或尚未读取。</EmptyLine>}</div>
      <fieldset><legend>清洗选项</legend><div className={css.manualCleaningGrid}>{CLEANING_OPTIONS.map(([key, label]) => <label key={key}><input type="checkbox" checked={cleaning[key]} onChange={(event) => onCleaning({ ...cleaning, [key]: event.target.checked })} />{label}</label>)}</div></fieldset>
      <label className={css.manualInlineField}><span>最小词数</span><input type="number" min={1} max={100} value={minimumWords} onChange={(event) => onMinimumWords(Math.max(1, Number(event.target.value) || 1))} /></label>
    </div>
}

const DependencyNotice = ({ children }: { children: React.ReactNode }): React.ReactElement => <div className={css.manualDependencyNotice}><IconSettingsOutline16 /><span>此项需要：{children}</span></div>
const NumberField = ({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }): React.ReactElement => <label><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>
const PreviewTable = ({ rows }: { rows: Array<Record<string, unknown>> }): React.ReactElement => {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 8)
  return <div className={css.manualPreview}><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row._theta_sample_id ?? index)}>{columns.map((column) => <td key={column} title={String(row[column] ?? '')}>{String(row[column] ?? '').slice(0, 120)}</td>)}</tr>)}</tbody></table></div>
}
const StageSection = ({ title, description, children }: { title: string; description: string; children: React.ReactNode }): React.ReactElement => <section className={css.manualSection}><header><h2>{title}</h2><p>{description}</p></header>{children}</section>
const Metric = ({ label, value }: { label: string; value: string }): React.ReactElement => <div className={css.manualMetric}><small>{label}</small><strong>{value}</strong></div>
const EmptyLine = ({ children }: { children: React.ReactNode }): React.ReactElement => <div className={css.manualEmptyLine}>{children}</div>
const stringValue = (record: Record<string, unknown>, key: string): string | undefined => typeof record[key] === 'string' ? record[key] : undefined
const readableBytes = (value: number): string => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
const statusLabel = (status?: string): string => ({ running: '运行中', waiting_human: '等待确认', completed: '已完成', failed: '运行失败', quarantined: '已隔离' })[status ?? ''] ?? status ?? '同步中'
const formatTime = (value: string): string => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
