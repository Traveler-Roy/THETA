
import { OPEN_SOURCE_EDITION } from '@/lib/edition'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  createProject as createProjectRequest,
  createWorkspaceSession,
  createRun,
  deleteProject as deleteProjectRequest,
  deleteRun,
  getConversation,
  getEvents,
  getReasoning,
  getRun,
  setAnalysisMode,
  getRuntimeProfile,
  getWorkspaceConversation,
  listProjects,
  listWorkspaceSessions,
  listRuns,
  openRunStream,
  postMessage,
  postWorkspaceMessage,
  stopRunGeneration,
  pinProject as pinProjectRequest,
  renameProject as renameProjectRequest,
  runWorkflowAction,
  type WebAgentInteraction,
  type WebAttachment,
  type WebConversationMemory,
  type WebDataset,
  type WebMessage,
  type WebReasoning,
  type WebRunDetail,
  type WebRunEvent,
  type WebRunStatus,
  type WebRunSummary,
  type WebRuntimeProfile,
  type WebRunResults,
  type WebTokenUsage,
  type WebWorkspaceSummary,
} from './api/client.ts'
import {
  Button,
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconChevronUpOutline14,
  IconEllipsisOutline16,
  IconEditOutline16,
  IconPanelLeftOutline16,
  IconSettingsOutline16,
  IconShareOutline16,
  IconTrashOutline16,
  Modal,
} from './ui/index.ts'
import { CatBrandWordmark } from './ui/CatBrandWordmark.tsx'
import { ConversationPane, type QueuedChatMessage } from './panels/ConversationPane.tsx'
import { DetailPane } from './panels/DetailPane.tsx'
import {
  createManualWorkspaceDraft,
  ManualWorkspace,
  type ManualWorkspaceDraft,
  type ManualOperationStatus,
} from './panels/ManualWorkspace.tsx'
import { SettingsDialog } from './panels/SettingsDialog.tsx'
import { usePreferences } from './preferences.tsx'
import { useAuth } from '@/contexts/auth-context'
import { accountStorageKey } from './storage-scope.ts'
import css from './styles/app.module.css'

type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting'
type WorkspaceMode = 'conversation' | 'manual'

interface LocalProject {
  id: string
  name: string
  createdAt: string
  pinned: boolean
  runIds: string[]
}

interface ProjectConversationMemory {
  messages: WebMessage[]
  attachments: WebAttachment[]
  interaction?: WebAgentInteraction
}

interface ProjectMemory extends ProjectConversationMemory {
  conversations?: Record<string, ProjectConversationMemory>
  workspaceSessionId?: string
  selectedRunId?: string
}

const PROJECTS_STORAGE_KEY = 'theta.workspace.projects.v1'
const PROJECT_ASSIGNMENTS_STORAGE_KEY = 'theta.workspace.project-assignments.v1'
const PROJECT_MEMORIES_STORAGE_KEY = 'theta.workspace.project-memories.v1'
const MANUAL_DRAFTS_STORAGE_KEY = 'theta.workspace.manual-drafts.v1'
const SIDEBAR_WIDTH_STORAGE_KEY = 'theta.workspace.sidebar-width.v1'
const ACCOUNT_NAME_STORAGE_KEY = 'theta.frontend.account-name.v1'
const WORKSPACE_MODE_STORAGE_KEY = 'theta.frontend.workspace-mode.v1'
const ACTIVE_CONVERSATION_STORAGE_KEY = 'theta.workspace.active-conversation.v1'
const HOME_URL = '/'
const DEFAULT_SIDEBAR_WIDTH = 232
const MIN_SIDEBAR_WIDTH = 176
const MAX_SIDEBAR_WIDTH = 360
const SIDEBAR_COLLAPSE_THRESHOLD = 120
const DRAFT_PROJECT_ID = '__theta_home_draft__'
const DEFAULT_PROJECTS: LocalProject[] = []
const conversationTitleFromText = (text: string, fallback = '新对话'): string => {
  const firstLine = text.trim().split(/\r?\n/u, 1)[0]?.trim() ?? ''
  const normalized = firstLine.replace(/\s+/gu, ' ')
  return normalized.slice(0, 120) || fallback
}

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)

const isTransientLocalError = (message: WebMessage): boolean =>
  message.messageKind === 'conversation.error' && message.messageId.startsWith('local.error.')

const withoutTransientLocalErrors = (messages: WebMessage[]): WebMessage[] =>
  messages.some(isTransientLocalError)
    ? messages.filter((message) => !isTransientLocalError(message))
    : messages

const compareMessageOrder = (left: WebMessage, right: WebMessage): number => {
  const leftTime = Date.parse(left.createdAt)
  const rightTime = Date.parse(right.createdAt)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime
  const leftSequence = Number.isFinite(left.sequenceNumber) ? left.sequenceNumber : Number.MAX_SAFE_INTEGER
  const rightSequence = Number.isFinite(right.sequenceNumber) ? right.sequenceNumber : Number.MAX_SAFE_INTEGER
  if (leftSequence !== rightSequence) return leftSequence - rightSequence
  if (left.role !== right.role) return left.role === 'user' ? -1 : 1
  return left.messageId.localeCompare(right.messageId)
}

const mergeStoredMessages = (
  current: WebMessage[],
  incoming: WebMessage[],
  excludedIds: string[] = [],
): WebMessage[] => {
  const excluded = new Set(excludedIds)
  const byId = new Map(
    withoutTransientLocalErrors(current)
      .filter((message) => !excluded.has(message.messageId))
      .map((message) => [message.messageId, message]),
  )
  for (const message of incoming) byId.set(message.messageId, message)
  return [...byId.values()].sort(compareMessageOrder)
}

const upsertLocalMessage = (
  current: WebMessage[],
  message: Omit<WebMessage, 'sequenceNumber'>,
): WebMessage[] => {
  const existing = current.find((item) => item.messageId === message.messageId)
  const nextMessage: WebMessage = {
    ...message,
    sequenceNumber: existing?.sequenceNumber ?? Math.max(0, ...current.map((item) => Number.isFinite(item.sequenceNumber) ? item.sequenceNumber : 0)) + 0.5,
  }
  return [...current.filter((item) => item.messageId !== message.messageId), nextMessage]
    .sort(compareMessageOrder)
}

const readStoredProjects = (storageKey = PROJECTS_STORAGE_KEY): LocalProject[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as unknown
    if (!Array.isArray(stored)) return DEFAULT_PROJECTS
    const projects = stored.filter((item): item is Omit<LocalProject, 'createdAt'> & { createdAt?: string } =>
      item != null && typeof item === 'object' &&
      typeof (item as LocalProject).id === 'string' &&
      typeof (item as LocalProject).name === 'string',
    )
    return projects.map((project, index) => ({
      ...project,
      runIds: Array.isArray(project.runIds) ? project.runIds.filter((runId): runId is string => typeof runId === 'string') : [],
      createdAt: typeof project.createdAt === 'string' && Number.isFinite(Date.parse(project.createdAt))
        ? project.createdAt
        : new Date(index).toISOString(),
    }))
  } catch {
    return DEFAULT_PROJECTS
  }
}

const readProjectAssignments = (storageKey = PROJECT_ASSIGNMENTS_STORAGE_KEY): Record<string, string> => {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as unknown
    return stored != null && typeof stored === 'object' && !Array.isArray(stored)
      ? stored as Record<string, string>
      : {}
  } catch {
    return {}
  }
}

const readProjectMemories = (storageKey = PROJECT_MEMORIES_STORAGE_KEY): Record<string, ProjectMemory> => {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as unknown
    if (stored == null || typeof stored !== 'object' || Array.isArray(stored)) return {}
    return Object.fromEntries(Object.entries(stored as Record<string, ProjectMemory>).map(([projectId, memory]) => {
      const conversations = Object.fromEntries(Object.entries(memory.conversations ?? {}).map(([conversationId, conversation]) => [
        conversationId,
        { ...conversation, messages: withoutTransientLocalErrors(conversation.messages ?? []) },
      ]))
      return [projectId, {
        ...memory,
        messages: withoutTransientLocalErrors(memory.messages ?? []),
        ...(Object.keys(conversations).length > 0 ? { conversations } : {}),
      }]
    }))
  } catch {
    return {}
  }
}

const readSidebarWidth = (): number => {
  const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
  if (raw == null) return DEFAULT_SIDEBAR_WIDTH
  const stored = Number(raw)
  if (!Number.isFinite(stored)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, stored))
}

const EMPTY_TOKEN_USAGE: WebTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  calls: 0,
}

const DATASET_UPLOAD_INTERACTION: WebAgentInteraction = {
  source: 'fsm',
  state: 'AwaitDataset',
  status: 'waiting_human',
  reasoning: {
    goal: '接收用户本地数据集',
    observation: '用户希望上传数据集文件。',
    decision: '显示本地文件选择卡片。',
    nextStates: [],
    allowedTools: [],
    policyRefs: [],
  },
  card: {
    kind: 'dataset_upload',
    title: '上传本地数据集',
    description: '选择本地文件以继续。',
    actionRef: 'frontend.dataset.upload',
    requiresHumanAction: true,
  },
}

const normalizeDatasetIntentText = (text: string): string =>
  text.replace(/[\s，。！？,.!?：:；;“”"'（）()]/gu, '')

const isDatasetUploadPrompt = (text: string): boolean => {
  const normalized = normalizeDatasetIntentText(text)
  return /(?:上传|导入|选择|提供|提交).*(?:数据集|数据文件|文本数据|文件)/u.test(normalized) ||
    /(?:数据集|数据文件|文本数据|文件).*(?:上传|导入|选择|提供|提交)/u.test(normalized) ||
    /(?:是否有|有没有|有无|有现成的?).*(?:数据集|数据文件|文本数据|文件)/u.test(normalized)
}

const readManualDrafts = (storageKey = MANUAL_DRAFTS_STORAGE_KEY): Record<string, ManualWorkspaceDraft> => {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as unknown
    if (stored == null || typeof stored !== 'object' || Array.isArray(stored)) return {}
    return stored as Record<string, ManualWorkspaceDraft>
  } catch {
    return {}
  }
}

const hasExplicitDatasetAvailability = (text: string): boolean => {
  const normalized = normalizeDatasetIntentText(text)
  return /^(?:我)?(?:这里|这边|手上|本地)?(?:已经|现在)?有(?:现成的?)?(?:一个|一些)?(?:文本)?(?:数据集|数据|数据文件|文件)(?:了)?$/u.test(normalized) ||
    /^(?:我)?(?:已经|现在)?(?:准备好|准备好了|拿到|拥有)(?:一个|一些)?(?:文本)?(?:数据集|数据|数据文件|文件)(?:了)?$/u.test(normalized) ||
    /^(?:数据集|数据文件|文本数据|文件)(?:已经|都)?(?:准备好|准备好了|有了|在本地)$/u.test(normalized)
}

const isDatasetUploadRequest = (text: string, previousMessages: WebMessage[] = []): boolean => {
  const normalized = normalizeDatasetIntentText(text)
  if (/(?:已|已经|刚|成功).{0,4}上传|上传.{0,4}(?:成功|完成|好了)/u.test(normalized)) return false
  const containsDatasetSubject = /(?:数据集|数据文件|文本数据|文件)/u.test(normalized)
  const isNegative = /(?:没有|没准备|暂无|无|不需要|不想|不要|暂时不|先不).{0,6}(?:数据集|数据|文件)/u.test(normalized) ||
    /(?:数据集|数据文件|文本数据|文件).{0,6}(?:没有|不存在|不上传|不用上传)/u.test(normalized)
  if (isNegative) return false

  const hasDirectUploadIntent = /(?:上传|导入|添加|选择|提供|提交).*(?:数据集|数据文件|文本数据|文件)/u.test(normalized) ||
    /(?:数据集|数据文件|文本数据|文件).*(?:上传|导入|添加|选择|提供|提交)/u.test(normalized) ||
    /(?:我要|我想|我准备|我需要|帮我)?传(?:一个|一下|我的)?(?:数据集|数据文件|文本数据|文件)/u.test(normalized)
  if (hasDirectUploadIntent) return true

  if (hasExplicitDatasetAvailability(text)) return true

  const isAffirmativeReply = /^(?:有|有的|我有|可以|好的?|是的?|要|需要)$/u.test(normalized)
  if (!isAffirmativeReply || containsDatasetSubject) return false
  const latestAssistantMessage = [...previousMessages].reverse().find((message) =>
    message.role === 'assistant' && message.messageKind === 'conversation.text',
  )
  return latestAssistantMessage != null && isDatasetUploadPrompt(latestAssistantMessage.content)
}

const createDatasetUploadCardMessage = (sequenceNumber: number): WebMessage => ({
  messageId: `local.dataset-card.${crypto.randomUUID()}`,
  role: 'assistant',
  messageKind: 'conversation.dataset-upload-card',
  content: DATASET_UPLOAD_INTERACTION.card?.description ?? '',
  sequenceNumber,
  createdAt: new Date().toISOString(),
})

const shouldRecoverDatasetUploadCard = (messages: WebMessage[], attachments: WebAttachment[]): boolean => {
  if (attachments.some((attachment) => attachment.kind === 'dataset') ||
    messages.some((message) => message.messageKind === 'conversation.dataset-upload-card')) return false

  const latestUserIndex = messages.findLastIndex((message) =>
    message.role === 'user' && message.messageKind === 'conversation.text',
  )
  if (latestUserIndex < 0) return false
  const latestUserMessage = messages[latestUserIndex]
  if (latestUserMessage == null || !isDatasetUploadRequest(latestUserMessage.content, messages.slice(0, latestUserIndex))) return false

  const assistantReply = messages.slice(latestUserIndex + 1).find((message) =>
    message.role === 'assistant' && message.messageKind === 'conversation.text',
  )
  return assistantReply != null && isDatasetUploadPrompt(assistantReply.content)
}

const readWorkspaceMode = (): WorkspaceMode => {
  const requested = new URLSearchParams(window.location.search).get('mode')
  if (requested === 'conversation' || requested === 'manual') return requested
  return localStorage.getItem(WORKSPACE_MODE_STORAGE_KEY) === 'manual' ? 'manual' : 'conversation'
}

export const AppRoot = (): React.ReactElement => {
  const { locale, t } = usePreferences()
  const router = useRouter()
  const { user, loading: authLoading, logout } = useAuth()
  const accountScope = user?.id ?? 'anonymous'
  const navigationKey = accountStorageKey(ACTIVE_CONVERSATION_STORAGE_KEY, user?.id)
  const restoreConversationRef = useRef<string | null>(sessionStorage.getItem(navigationKey))
  const storageKeys = useMemo(() => ({
    projects: accountStorageKey(PROJECTS_STORAGE_KEY, user?.id),
    assignments: accountStorageKey(PROJECT_ASSIGNMENTS_STORAGE_KEY, user?.id),
    memories: accountStorageKey(PROJECT_MEMORIES_STORAGE_KEY, user?.id),
    manualDrafts: accountStorageKey(MANUAL_DRAFTS_STORAGE_KEY, user?.id),
    accountName: accountStorageKey(ACCOUNT_NAME_STORAGE_KEY, user?.id),
  }), [user?.id])
  const initialProjectId = useRef(DRAFT_PROJECT_ID).current
  const initialProjects = useRef(readStoredProjects(storageKeys.projects)).current
  const initialProjectMemories = useRef(readProjectMemories(storageKeys.memories)).current
  const [projects, setProjects] = useState<LocalProject[]>(initialProjects)
  const [projectAssignments, setProjectAssignments] = useState<Record<string, string>>(() => readProjectAssignments(storageKeys.assignments))
  const [projectMemories, setProjectMemories] = useState<Record<string, ProjectMemory>>(initialProjectMemories)
  const [activeProjectId, setActiveProjectId] = useState(initialProjectId)
  const [manualDrafts, setManualDrafts] = useState<Record<string, ManualWorkspaceDraft>>(() => ({
    ...readManualDrafts(storageKeys.manualDrafts),
    [initialProjectId]: createManualWorkspaceDraft(),
  }))
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string>()
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())
  const [analysisMode, setLocalAnalysisMode] = useState<'topic' | 'free'>('topic')
  const [analysisModeBusy, setAnalysisModeBusy] = useState(false)
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(readWorkspaceMode)
  const [projectToDelete, setProjectToDelete] = useState<LocalProject>()
  const [projectDeleteBusy, setProjectDeleteBusy] = useState(false)
  const [projectDeleteError, setProjectDeleteError] = useState<string>()
  const [projectToRename, setProjectToRename] = useState<LocalProject>()
  const [projectRenameName, setProjectRenameName] = useState('')
  const [projectRenameBusy, setProjectRenameBusy] = useState(false)
  const [projectRenameError, setProjectRenameError] = useState<string>()
  const [projectCreateOpen, setProjectCreateOpen] = useState(false)
  const [projectCreateName, setProjectCreateName] = useState('')
  const [projectCreateBusy, setProjectCreateBusy] = useState(false)
  const [projectCreateError, setProjectCreateError] = useState<string>()
  const [runs, setRuns] = useState<WebRunSummary[]>([])
  const [workspaceSessions, setWorkspaceSessions] = useState<WebWorkspaceSummary[]>([])
  const [runsLoading, setRunsLoading] = useState(true)
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>()
  const [messages, setMessages] = useState<WebMessage[]>([])
  const [status, setStatus] = useState<WebRunStatus>()
  const [runDetail, setRunDetail] = useState<WebRunDetail>()
  const [events, setEvents] = useState<WebRunEvent[]>([])
  const [reasoning, setReasoning] = useState<WebReasoning>()
  const [results, setResults] = useState<WebRunResults>()
  const [memory, setMemory] = useState<WebConversationMemory>()
  const [tokenUsage, setTokenUsage] = useState<WebTokenUsage>(EMPTY_TOKEN_USAGE)
  const [sending, setSending] = useState(false)
  const [processingMessageId, setProcessingMessageId] = useState<string>()
  const [manualOperation, setManualOperation] = useState<ManualOperationStatus>()
  const [activeScopeKey, setActiveScopeKey] = useState(() => `draft:${crypto.randomUUID()}`)
  const [queued, setQueued] = useState<Array<QueuedChatMessage & {
    runId?: string
    workspaceSessionId?: string
    scopeKey: string
    analysisMode: 'topic' | 'free'
    projectId: string
    optimisticMessageId?: string
  }>>([])
  const [attachments, setAttachments] = useState<WebAttachment[]>([])
  const [loadError, setLoadError] = useState<string>()
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [runtimeProfile, setRuntimeProfile] = useState<WebRuntimeProfile>()
  const [workspaceSessionId, setWorkspaceSessionId] = useState<string | undefined>()
  const [workspaceInteraction, setWorkspaceInteraction] = useState<WebAgentInteraction | undefined>()
  const [workspaceActivity, setWorkspaceActivity] = useState<{ proposal?: unknown; semanticDecision?: unknown; steps?: unknown; result?: unknown; evidenceRefs?: unknown }>()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [detailOpen, setDetailOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [accountName, setAccountName] = useState(() => localStorage.getItem(storageKeys.accountName) || 'user')
  const [liveAssistantMessageId, setLiveAssistantMessageId] = useState<string>()
  const knownMessageIds = useRef(new Set<string>())
  const activeScopeRef = useRef(activeScopeKey)
  const activeProjectIdRef = useRef(activeProjectId)
  const processingMessageRef = useRef<string | undefined>(undefined)
  const queuedSubmissionCountRef = useRef(0)
  const activeRequestControllerRef = useRef<AbortController | undefined>(undefined)
  const awaitingRenderRef = useRef<{ messageId: string; queueId: string } | undefined>(undefined)
  const finishedQueueIdsRef = useRef(new Set<string>())
  const preserveMessagesRunRef = useRef<string | undefined>(undefined)
  const projectMemoriesRef = useRef(projectMemories)
  const messagesRef = useRef(messages)
  const manualOperationProjectRef = useRef(new Map<string, string>())
  const sidebarResizeStartRef = useRef<{ pointerX: number; width: number } | undefined>(undefined)
  const accountScopeRef = useRef(accountScope)
  const authRedirectingRef = useRef(false)

  useEffect(() => {
    setAccountName(user?.username ?? 'user')
  }, [user?.id, user?.username])

  useEffect(() => {
    if (!accountMenuOpen) return
    const closeMenu = (event: PointerEvent): void => {
      if (event.target instanceof Element && !event.target.closest('[data-account-menu]')) {
        setAccountMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAccountMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [accountMenuOpen])

  useEffect(() => {
    if (accountScopeRef.current === accountScope) return
    accountScopeRef.current = accountScope
    const nextProjects = readStoredProjects(storageKeys.projects)
    setProjects(nextProjects)
    setProjectAssignments(readProjectAssignments(storageKeys.assignments))
    setProjectMemories(readProjectMemories(storageKeys.memories))
    setManualDrafts({
      ...readManualDrafts(storageKeys.manualDrafts),
      [DRAFT_PROJECT_ID]: createManualWorkspaceDraft(),
    })
    setActiveProjectId(DRAFT_PROJECT_ID)
    activeProjectIdRef.current = DRAFT_PROJECT_ID
    setSelectedRunId(undefined)
    setWorkspaceSessionId(undefined)
    setMessages([])
    setAttachments([])
    setWorkspaceInteraction(undefined)
    setWorkspaceActivity(undefined)
    setLoadError(undefined)
    knownMessageIds.current.clear()
  }, [accountScope, storageKeys.assignments, storageKeys.manualDrafts, storageKeys.memories, storageKeys.projects])

  useEffect(() => {
    localStorage.setItem(storageKeys.projects, JSON.stringify(projects))
  }, [projects, storageKeys.projects])

  useEffect(() => {
    localStorage.setItem(storageKeys.assignments, JSON.stringify(projectAssignments))
  }, [projectAssignments, storageKeys.assignments])

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId
  }, [activeProjectId])

  useEffect(() => {
    projectMemoriesRef.current = projectMemories
    localStorage.setItem(storageKeys.memories, JSON.stringify(projectMemories))
  }, [projectMemories, storageKeys.memories])

  useEffect(() => {
    const serializable = Object.fromEntries(Object.entries(manualDrafts).map(([projectId, draft]) => [
      projectId,
      { ...draft, pendingFile: undefined },
    ]))
    localStorage.setItem(storageKeys.manualDrafts, JSON.stringify(serializable))
  }, [manualDrafts, storageKeys.manualDrafts])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    if (activeProjectId === DRAFT_PROJECT_ID || !shouldRecoverDatasetUploadCard(messages, attachments)) return
    setMessages((current) => {
      if (!shouldRecoverDatasetUploadCard(current, attachments)) return current
      const cardMessage = createDatasetUploadCardMessage(
        Math.max(0, ...current.map((message) => message.sequenceNumber)) + 1,
      )
      knownMessageIds.current.add(cardMessage.messageId)
      const next = [...current, cardMessage]
      messagesRef.current = next
      return next
    })
  }, [activeProjectId, attachments, messages])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem(WORKSPACE_MODE_STORAGE_KEY, workspaceMode)
    const url = new URL(window.location.href)
    url.searchParams.set('mode', workspaceMode)
    window.history.replaceState(null, '', `${url.pathname}${url.search}`)
  }, [workspaceMode])

  useEffect(() => {
    if (!sidebarResizing) return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onPointerMove = (event: PointerEvent): void => {
      const start = sidebarResizeStartRef.current
      if (start == null) return
      const nextWidth = start.width + event.clientX - start.pointerX
      if (nextWidth <= SIDEBAR_COLLAPSE_THRESHOLD) {
        setSidebarOpen(false)
        return
      }
      setSidebarOpen(true)
      setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, nextWidth)))
    }
    const stopResizing = (): void => {
      sidebarResizeStartRef.current = undefined
      setSidebarResizing(false)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [sidebarResizing])

  useEffect(() => {
    const conversationId = workspaceSessionId ?? selectedRunId
    if (activeProjectId === DRAFT_PROJECT_ID || conversationId == null) return
    const conversation: ProjectConversationMemory = {
      messages: withoutTransientLocalErrors(messages),
      attachments,
      ...(workspaceInteraction ? { interaction: workspaceInteraction } : {}),
    }
    const next: ProjectMemory = {
      messages: conversation.messages,
      attachments: conversation.attachments,
      ...(conversation.interaction ? { interaction: conversation.interaction } : {}),
      conversations: {
        ...(projectMemoriesRef.current[activeProjectId]?.conversations ?? {}),
        [conversationId]: conversation,
      },
      ...(workspaceSessionId ? { workspaceSessionId } : {}),
      ...(selectedRunId ? { selectedRunId } : {}),
    }
    setProjectMemories((current) => {
      const previous = current[activeProjectId]
      const previousConversation = previous?.conversations?.[conversationId]
      if (previousConversation?.messages === conversation.messages && previousConversation.attachments === attachments &&
        previousConversation.interaction === workspaceInteraction && previous?.workspaceSessionId === workspaceSessionId &&
        previous?.selectedRunId === selectedRunId) return current
      return { ...current, [activeProjectId]: next }
    })
  }, [activeProjectId, attachments, messages, selectedRunId, workspaceInteraction, workspaceSessionId])

  useEffect(() => {
    const interaction = status?.interaction
    const card = interaction?.card
    if (activeProjectId === DRAFT_PROJECT_ID || selectedRunId == null || interaction == null || card == null ||
      card.kind === 'action_review' || card.kind === 'dataset_upload' || card.kind === 'research_question') return
    const eventKey = (card.actionRef ?? card.kind).replace(/[^a-zA-Z0-9_.-]/gu, '-')
    const localMessage = {
      messageId: `local.interaction.${selectedRunId}.${eventKey}`,
      role: 'assistant' as const,
      messageKind: 'activity.interaction.snapshot',
      content: JSON.stringify({ runId: selectedRunId, interaction }),
      createdAt: status?.lastEventAt ?? new Date().toISOString(),
    }
    knownMessageIds.current.add(localMessage.messageId)
    setMessages((current) => {
      const next = upsertLocalMessage(current, localMessage)
      messagesRef.current = next
      return next
    })
  }, [activeProjectId, selectedRunId, status?.interaction, status?.lastEventAt])

  const projectIdFor = useCallback((itemId: string): string => {
    const serverProjectId = runs.find((run) => run.runId === itemId)?.projectId
    if (serverProjectId) return serverProjectId
    const assignedProjectId = projectAssignments[itemId]
    return assignedProjectId && projects.some((project) => project.id === assignedProjectId)
      ? assignedProjectId
      : DRAFT_PROJECT_ID
  }, [projectAssignments, projects, runs])

  const assignItemToProject = useCallback((itemId: string, projectId: string): void => {
    setProjectAssignments((current) => {
      if (projectId === DRAFT_PROJECT_ID) {
        if (!(itemId in current)) return current
        const next = { ...current }
        delete next[itemId]
        return next
      }
      return current[itemId] === projectId ? current : { ...current, [itemId]: projectId }
    })
    if (projectId !== DRAFT_PROJECT_ID) {
      setProjects((current) => current.map((project) => project.id === projectId && !project.runIds.includes(itemId)
        ? { ...project, runIds: [...project.runIds, itemId] }
        : project,
      ))
    }
  }, [])

  const cacheProjectResult = useCallback((
    projectId: string,
    incoming: WebMessage[],
    excludedIds: string[],
    identity: { selectedRunId?: string; workspaceSessionId?: string } = {},
  ): void => {
    if (projectId === DRAFT_PROJECT_ID) return
    setProjectMemories((current) => {
      const previous = current[projectId] ?? { messages: [], attachments: [] }
      const conversationId = identity.selectedRunId ?? identity.workspaceSessionId
      const previousConversation = conversationId
        ? previous.conversations?.[conversationId]
        : undefined
      const nextConversation = conversationId
        ? {
            ...(previousConversation ?? { messages: [], attachments: [] }),
            messages: mergeStoredMessages(previousConversation?.messages ?? [], incoming, excludedIds),
          }
        : undefined
      return {
        ...current,
        [projectId]: {
          ...previous,
          messages: nextConversation?.messages ?? mergeStoredMessages(previous.messages, incoming, excludedIds),
          attachments: nextConversation?.attachments ?? previous.attachments,
          ...(nextConversation?.interaction ? { interaction: nextConversation.interaction } : {}),
          ...(conversationId && nextConversation ? {
            conversations: {
              ...(previous.conversations ?? {}),
              [conversationId]: nextConversation,
            },
          } : {}),
          ...identity,
        },
      }
    })
  }, [])

  const finishQueuedMessage = useCallback((queueId: string): void => {
    if (finishedQueueIdsRef.current.has(queueId)) return
    finishedQueueIdsRef.current.add(queueId)
    setQueued((current) => current.filter((item) => item.id !== queueId))
    queuedSubmissionCountRef.current = Math.max(0, queuedSubmissionCountRef.current - 1)
    if (processingMessageRef.current === queueId) processingMessageRef.current = undefined
    if (awaitingRenderRef.current?.queueId === queueId) awaitingRenderRef.current = undefined
    activeRequestControllerRef.current = undefined
    setProcessingMessageId(undefined)
    setSending(false)
  }, [])

  const optimisticMessages = useCallback((
    id: string,
    text: string,
    nextAttachments: WebAttachment[],
    sequence: number,
  ): WebMessage[] => {
    const createdAt = new Date().toISOString()
    return [
      {
        messageId: `optimistic.${id}`,
        role: 'user',
        messageKind: 'conversation.text',
        content: text,
        sequenceNumber: sequence,
        createdAt,
      },
      ...(nextAttachments.length > 0 ? [{
        messageId: `optimistic.${id}.attachments`,
        role: 'user' as const,
        messageKind: 'conversation.attachment',
        content: JSON.stringify({ attachments: nextAttachments }),
        sequenceNumber: sequence + 1,
        createdAt,
      }] : []),
    ]
  }, [])

  const activateScope = useCallback((scopeKey: string): void => {
    activeScopeRef.current = scopeKey
    setActiveScopeKey(scopeKey)
  }, [])

  const refreshRuns = useCallback(async () => {
    try {
      const data = await listRuns()
      setRuns(data.runs)
      setProjectAssignments((current) => ({
        ...current,
        ...Object.fromEntries(data.runs.map((run) => [run.runId, run.projectId])),
      }))
      setSelectedRunId((current) => {
        if (current != null && data.runs.some((run) => run.runId === current)) return current
        return undefined
      })
      setLoadError(undefined)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunsLoading(false)
    }
  }, [])

  const refreshProjects = useCallback(async () => {
    const data = await listProjects()
    const serverProjects = data.projects.map(({ id, name, createdAt, pinned, runIds }) => ({ id, name, createdAt, pinned, runIds }))
    const serverProjectIds = new Set(serverProjects.map((project) => project.id))
    setProjects(serverProjects)
    setProjectAssignments((current) => ({
      ...Object.fromEntries(Object.entries(current).filter(([, projectId]) => serverProjectIds.has(projectId))),
      ...Object.fromEntries(serverProjects.flatMap((project) => project.runIds.map((runId) => [runId, project.id]))),
    }))
    setProjectMemories((current) => Object.fromEntries(
      Object.entries(current).filter(([projectId]) => serverProjectIds.has(projectId)),
    ))
    setManualDrafts((current) => Object.fromEntries(
      Object.entries(current).filter(([projectId]) => projectId === DRAFT_PROJECT_ID || serverProjectIds.has(projectId)),
    ))
  }, [])

  const refreshWorkspaceSessions = useCallback(async () => {
    try {
      setWorkspaceSessions((await listWorkspaceSessions()).sessions)
    } catch {
      setWorkspaceSessions([])
    }
  }, [])

  useEffect(() => {
    if (authLoading) return
    if (!user && !OPEN_SOURCE_EDITION) {
      setRuns([])
      setWorkspaceSessions([])
      setRunsLoading(false)
      return
    }
    void refreshRuns()
    void refreshProjects().catch((error) => {
      setLoadError(error instanceof Error ? error.message : String(error))
    })
    void refreshWorkspaceSessions()
  }, [authLoading, refreshProjects, refreshRuns, refreshWorkspaceSessions, user?.id])

  const requireAuthentication = useCallback((): boolean => {
    if (OPEN_SOURCE_EDITION) return true
    if (authLoading) return false
    if (user) return true
    if (authRedirectingRef.current) return false
    authRedirectingRef.current = true
    toast.error('您当前暂未登录，登陆后进行后续使用。', { duration: 5000 })
    router.replace('/?auth=login')
    return false
  }, [authLoading, router, user])

  useEffect(() => {
    if (!authLoading && !user) requireAuthentication()
  }, [authLoading, requireAuthentication, user])

  const ensureProject = useCallback(async (suggestedName: string): Promise<string> => {
    if (!requireAuthentication()) throw new Error('请先登录。')
    const currentProjectId = activeProjectIdRef.current
    if (currentProjectId !== DRAFT_PROJECT_ID && (
      projects.some((project) => project.id === currentProjectId) || isUuid(currentProjectId)
    )) {
      return currentProjectId
    }
    const created = await createProjectRequest(suggestedName.trim().replace(/\s+/gu, ' ') || '新分析项目')
    setProjects((current) => current.some((project) => project.id === created.id)
      ? current
      : [...current, { id: created.id, name: created.name, createdAt: created.createdAt, pinned: created.pinned, runIds: created.runIds }])
    setManualDrafts((current) => ({
      ...current,
      [created.id]: current[currentProjectId] ?? createManualWorkspaceDraft(),
    }))
    setActiveProjectId(created.id)
    activeProjectIdRef.current = created.id
    return created.id
  }, [projects, requireAuthentication])

  useEffect(() => {
    void getRuntimeProfile()
      .then((profile) => {
        setRuntimeProfile(profile)
      })
      .catch(() => setRuntimeProfile(undefined))
  }, [])

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 900px)')
    const syncPanels = (matches: boolean): void => {
      setSidebarOpen(!matches)
      setDetailOpen(!matches)
    }
    syncPanels(narrow.matches)
    const onChange = (event: MediaQueryListEvent): void => syncPanels(event.matches)
    narrow.addEventListener('change', onChange)
    return () => narrow.removeEventListener('change', onChange)
  }, [])

  const mergeMessages = useCallback((incoming: WebMessage[]) => {
    setMessages((current) => {
      const next = [...current]
      for (const message of incoming) {
        if (knownMessageIds.current.has(message.messageId)) {
          const index = next.findIndex(item => item.messageId === message.messageId)
          if (index >= 0) next[index] = message
          continue
        }
        if (message.role === 'user') {
          const optimisticIndex = next.findIndex((item) =>
            item.messageId.startsWith('optimistic.') && item.role === 'user' && item.content === message.content,
          )
          if (optimisticIndex >= 0) {
            const optimistic = next[optimisticIndex]
            if (optimistic) knownMessageIds.current.delete(optimistic.messageId)
            next.splice(optimisticIndex, 1)
          }
        }
        knownMessageIds.current.add(message.messageId)
        next.push(message)
      }
      next.sort(compareMessageOrder)
      messagesRef.current = next
      return next
    })
  }, [])

  const appendProjectNotice = useCallback((projectId: string, content: string): void => {
    const createdAt = new Date().toISOString()
    const sourceMessages = activeProjectIdRef.current === projectId
      ? messagesRef.current
      : projectMemoriesRef.current[projectId]?.messages ?? []
    const localMessage: WebMessage = {
      messageId: `local.manual-notice.${crypto.randomUUID()}`,
      role: 'assistant',
      messageKind: 'conversation.text',
      content,
      sequenceNumber: Math.max(0, ...sourceMessages.map((message) => Number.isFinite(message.sequenceNumber) ? message.sequenceNumber : 0)) + 1,
      createdAt,
    }
    if (activeProjectIdRef.current === projectId) {
      knownMessageIds.current.add(localMessage.messageId)
      setMessages((current) => {
        const next = [...current, localMessage].sort(compareMessageOrder)
        messagesRef.current = next
        return next
      })
      return
    }
    if (projectId !== DRAFT_PROJECT_ID) {
      setProjectMemories((current) => {
        const previous = current[projectId] ?? { messages: [], attachments: [] }
        return {
          ...current,
          [projectId]: { ...previous, messages: [...previous.messages, localMessage].sort(compareMessageOrder) },
        }
      })
    }
  }, [])

  const appendConversationNotice = useCallback((content: string): void => {
    appendProjectNotice(activeProjectIdRef.current, content)
  }, [appendProjectNotice])

  const handleManualOperationChange = useCallback((operation: ManualOperationStatus): void => {
    let projectId = manualOperationProjectRef.current.get(operation.id)
    if (projectId == null) {
      projectId = activeProjectIdRef.current
      manualOperationProjectRef.current.set(operation.id, projectId)
    }

    if (operation.state === 'running') {
      setManualOperation(operation)
    } else {
      setManualOperation((current) => current?.id === operation.id ? undefined : current)
    }

    const localMessage = {
      messageId: `local.manual-operation.${operation.id}`,
      role: 'assistant' as const,
      messageKind: 'activity.manual-operation',
      content: JSON.stringify(operation),
      createdAt: operation.startedAt,
    }

    if (activeProjectIdRef.current === projectId) {
      knownMessageIds.current.add(localMessage.messageId)
      setMessages((current) => {
        const next = upsertLocalMessage(current, localMessage)
        messagesRef.current = next
        return next
      })
    } else if (projectId !== DRAFT_PROJECT_ID) {
      setProjectMemories((current) => {
        const previous = current[projectId] ?? { messages: [], attachments: [] }
        return {
          ...current,
          [projectId]: {
            ...previous,
            messages: upsertLocalMessage(previous.messages, localMessage),
          },
        }
      })
    }

    if (operation.state !== 'running') manualOperationProjectRef.current.delete(operation.id)
  }, [])

  const mergeManualConversationMessages = useCallback((runId: string, incoming: WebMessage[]): void => {
    const projectId = projectIdFor(runId)
    cacheProjectResult(projectId, incoming, [], { selectedRunId: runId, workspaceSessionId: undefined })
    if (activeProjectIdRef.current === projectId) mergeMessages(incoming)
  }, [cacheProjectResult, mergeMessages, projectIdFor])

  const refreshRun = useCallback(async () => {
    if (!selectedRunId) return
    try {
      const [detail, conversation, eventData, reasoningData] = await Promise.all([
        getRun(selectedRunId),
        getConversation(selectedRunId),
        getEvents(selectedRunId, { limit: 300 }),
        getReasoning(selectedRunId),
      ])
      setStatus(detail.status)
      setRunDetail(detail)
      mergeMessages(conversation.messages)
      setEvents(eventData.events)
      setReasoning(reasoningData)
      setResults(detail.results)
      setMemory(conversation.memory)
      setTokenUsage(conversation.tokenUsage)
      setLoadError(undefined)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
    void refreshRuns()
  }, [selectedRunId, mergeMessages, refreshRuns])

  useEffect(() => {
    if (!selectedRunId) {
      setStreamState('idle')
      return
    }
    let cancelled = false
    let reasoningTimer: number | undefined
    const projectMemory = projectMemoriesRef.current[projectIdFor(selectedRunId)]
    const cachedMessages = projectMemory?.selectedRunId === selectedRunId
      ? withoutTransientLocalErrors(projectMemory.messages)
      : []
    const preserveCurrentMessages = preserveMessagesRunRef.current === selectedRunId
    if (preserveCurrentMessages) preserveMessagesRunRef.current = undefined
    setLoadError(undefined)
    if (!preserveCurrentMessages) setMessages(cachedMessages)
    setAttachments(projectMemory?.attachments ?? [])
    setEvents([])
    setReasoning(undefined)
    setResults(undefined)
    setMemory(undefined)
    setTokenUsage(EMPTY_TOKEN_USAGE)
    setStatus(undefined)
    setRunDetail(undefined)
    setStreamState('connecting')
    knownMessageIds.current.clear()
    const visibleMessages = preserveCurrentMessages ? messagesRef.current : cachedMessages
    visibleMessages.forEach((message) => knownMessageIds.current.add(message.messageId))

    void (async () => {
      try {
        const [detail, conversation, eventData, reasoningData] = await Promise.all([
          getRun(selectedRunId),
          getConversation(selectedRunId),
          getEvents(selectedRunId, { limit: 300 }),
          getReasoning(selectedRunId),
        ])
        if (cancelled) return
        setStatus(detail.status)
        setRunDetail(detail)
        mergeMessages(conversation.messages)
        setEvents(eventData.events)
        setReasoning(reasoningData)
        setResults(detail.results)
        setMemory(conversation.memory)
        setTokenUsage(conversation.tokenUsage)
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      }
    })()

    const scheduleReasoningRefresh = (): void => {
      window.clearTimeout(reasoningTimer)
      reasoningTimer = window.setTimeout(() => {
        void getReasoning(selectedRunId)
          .then((data) => {
            if (!cancelled) setReasoning(data)
          })
          .catch(() => undefined)
      }, 250)
    }
    const source = openRunStream(selectedRunId, {
      onOpen: () => setStreamState('live'),
      onSnapshot: (data) => {
        setStatus(data.status)
        setStreamState('live')
      },
      onStatus: (data) => {
        setStatus(data.status)
        if (data.status.status === 'completed') void refreshRun()
      },
      onEvents: (data) => {
        setEvents((current) => {
          const merged = new Map(current.map(event => [event.id, event]))
          for (const event of data.events) merged.set(event.id, event)
          return [...merged.values()].sort(
            (left, right) => left.timestamp.localeCompare(right.timestamp),
          )
        })
        scheduleReasoningRefresh()
      },
      onMessages: (data) => {
        const latest = [...data.messages].reverse().find((message) => message.role === 'assistant' && !message.messageKind.startsWith('activity.'))
        const queueId = processingMessageRef.current
        const receivedNewAssistant = latest != null && !knownMessageIds.current.has(latest.messageId)
        if (latest) setLiveAssistantMessageId(latest.messageId)
        mergeMessages(data.messages)
        // The message request owns completion; stream snapshots may contain earlier replies.
      },
      onError: () => setStreamState('reconnecting'),
    })
    return () => {
      cancelled = true
      window.clearTimeout(reasoningTimer)
      source.close()
    }
  }, [activeScopeKey, finishQueuedMessage, selectedRunId, mergeMessages, projectIdFor])

  const enqueue = useCallback((text: string, nextAttachments: WebAttachment[], projectId = activeProjectId) => {
    const id = crypto.randomUUID()
    const scopeKey = activeScopeRef.current
    const displayImmediately = processingMessageRef.current == null && queuedSubmissionCountRef.current === 0
    queuedSubmissionCountRef.current += 1
    const optimisticMessageId = displayImmediately ? `optimistic.${id}` : undefined
    if (optimisticMessageId) {
      knownMessageIds.current.add(optimisticMessageId)
      if (nextAttachments.length > 0) knownMessageIds.current.add(`${optimisticMessageId}.attachments`)
      setMessages((current) => [
        ...current,
        ...optimisticMessages(
          id,
          text,
          nextAttachments,
          Math.max(0, ...current.map((message) => message.sequenceNumber)) + 1,
        ),
      ])
    }
    setQueued((current) => [...current, {
      id,
      text,
      attachments: nextAttachments,
      scopeKey,
      analysisMode,
      projectId,
      ...(optimisticMessageId ? { optimisticMessageId } : {}),
      ...(selectedRunId ? { runId: selectedRunId } : {}),
      ...(workspaceSessionId ? { workspaceSessionId } : {}),
    }])
  }, [activeProjectId, analysisMode, optimisticMessages, selectedRunId, workspaceSessionId])

  const sendMessage = useCallback(async (text: string, nextAttachments: WebAttachment[]) => {
    if (!requireAuthentication()) return
    if (queuedSubmissionCountRef.current > 0 || processingMessageRef.current != null) return
    let projectId: string | undefined
    try {
      projectId = await ensureProject(conversationTitleFromText(text))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const id = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      const sequenceNumber = Math.max(0, ...messagesRef.current.map((message) => message.sequenceNumber)) + 1
      const failedMessage = {
        messageId: `local.error.${crypto.randomUUID()}`,
        role: 'assistant' as const,
        messageKind: 'conversation.error' as const,
        content: locale === 'zh-CN'
          ? `抱歉，无法创建项目或连接本地 THETA 服务。\n\n原因：${detail}\n\n请确认后端服务已在 127.0.0.1:4318 启动后重试。`
          : `Sorry, the project could not be created or the local THETA service could not be reached.\n\nReason: ${detail}\n\nStart the backend service on 127.0.0.1:4318 and try again.`,
        sequenceNumber: sequenceNumber + Math.max(1, nextAttachments.length + 1),
        createdAt,
      }
      const failedConversationMessages = [...optimisticMessages(id, text, nextAttachments, sequenceNumber), failedMessage]
      setMessages((current) => {
        const next = [...current, ...failedConversationMessages]
        messagesRef.current = next
        return next
      })
      if (projectId && projectId !== DRAFT_PROJECT_ID) {
        const failedProjectId = projectId
        setProjectMemories((current) => {
          const previous = current[failedProjectId] ?? { messages: [], attachments: [] }
          return {
            ...current,
            [failedProjectId]: {
              ...previous,
              messages: mergeStoredMessages(previous.messages, failedConversationMessages),
              attachments: nextAttachments,
            },
          }
        })
      }
      setLoadError(undefined)
      return
    }

    enqueue(text, nextAttachments, projectId)
  }, [enqueue, ensureProject, locale, optimisticMessages, requireAuthentication])

  useEffect(() => {
    const next = queued[0]
    if (!next || processingMessageRef.current) return
    processingMessageRef.current = next.id
    setProcessingMessageId(next.id)
    setSending(true)
    setLoadError(undefined)
    const controller = new AbortController()
    activeRequestControllerRef.current = controller
    const activeOptimisticMessageId = next.optimisticMessageId ?? `optimistic.${next.id}`
    if (!next.optimisticMessageId && activeScopeRef.current === next.scopeKey) {
      knownMessageIds.current.add(activeOptimisticMessageId)
      if (next.attachments.length > 0) knownMessageIds.current.add(`${activeOptimisticMessageId}.attachments`)
      setMessages((current) => [
        ...current,
        ...optimisticMessages(
          next.id,
          next.text,
          next.attachments,
          Math.max(0, ...current.map((message) => message.sequenceNumber)) + 1,
        ),
      ])
    }
    void (async () => {
      try {
        if (next.runId) {
          const result = await postMessage(next.runId, next.text, true, next.attachments, controller.signal)
          cacheProjectResult(next.projectId, result.messages, [
            activeOptimisticMessageId,
            `${activeOptimisticMessageId}.attachments`,
          ], { selectedRunId: next.runId, workspaceSessionId: undefined })
          if (activeProjectIdRef.current === next.projectId) {
            knownMessageIds.current.delete(activeOptimisticMessageId)
            knownMessageIds.current.delete(`${activeOptimisticMessageId}.attachments`)
            setMessages((current) => current.filter((message) =>
              message.messageId !== activeOptimisticMessageId &&
              message.messageId !== `${activeOptimisticMessageId}.attachments` &&
              !isTransientLocalError(message),
            ))
            setStatus(result.status)
            const latest = [...result.messages].reverse().find((message) => message.role === 'assistant' && !message.messageKind.startsWith('activity.'))
            if (latest) {
              setLiveAssistantMessageId(latest.messageId)
            }
            mergeMessages(result.messages)
            setTokenUsage(result.tokenUsage)
          }
          void refreshRuns()
        } else {
          const datasetAttachment = next.attachments.find((attachment) => attachment.kind === 'dataset')
          if (datasetAttachment) {
            const createdRun = await createRun({
              projectId: next.projectId,
              datasetRef: datasetAttachment.id,
              analysisMode: next.analysisMode,
              useLanguageProvider: true,
              ...(next.workspaceSessionId ? { sourceSessionId: next.workspaceSessionId } : {}),
            })
            assignItemToProject(createdRun.runId, next.projectId)
            cacheProjectResult(next.projectId, [], [], { selectedRunId: createdRun.runId, workspaceSessionId: undefined })
            if (activeProjectIdRef.current === next.projectId) {
              activateScope(`run:${createdRun.runId}:${crypto.randomUUID()}`)
              preserveMessagesRunRef.current = createdRun.runId
              setSelectedRunId(createdRun.runId)
              setWorkspaceSessionId(undefined)
              setWorkspaceActivity(undefined)
              setWorkspaceInteraction(undefined)
              setTokenUsage(EMPTY_TOKEN_USAGE)
            }
            const result = await postMessage(createdRun.runId, next.text, true, next.attachments, controller.signal)
            cacheProjectResult(next.projectId, result.messages, [
              activeOptimisticMessageId,
              `${activeOptimisticMessageId}.attachments`,
            ], { selectedRunId: createdRun.runId, workspaceSessionId: undefined })
            if (activeProjectIdRef.current === next.projectId) {
              knownMessageIds.current.delete(activeOptimisticMessageId)
              knownMessageIds.current.delete(`${activeOptimisticMessageId}.attachments`)
              setMessages((current) => current.filter((message) =>
                message.messageId !== activeOptimisticMessageId &&
                message.messageId !== `${activeOptimisticMessageId}.attachments` &&
                !isTransientLocalError(message),
              ))
              setStatus(result.status)
              const latest = [...result.messages].reverse().find((message) => message.role === 'assistant' && !message.messageKind.startsWith('activity.'))
              if (latest) {
                setLiveAssistantMessageId(latest.messageId)
              }
              mergeMessages(result.messages)
              setTokenUsage(result.tokenUsage)
            }
            void refreshRuns()
            void refreshWorkspaceSessions()
            return
          }

          let sessionId = next.workspaceSessionId ?? workspaceSessionId
          let result: Awaited<ReturnType<typeof getWorkspaceConversation>>
          if (!sessionId) {
            const created = await createWorkspaceSession(next.projectId, conversationTitleFromText(next.text), next.text, next.analysisMode)
            sessionId = created.sessionId
            assignItemToProject(created.sessionId, next.projectId)
            const createdAt = new Date().toISOString()
            setWorkspaceSessions((current) => [{
              sessionId: created.sessionId,
              projectId: next.projectId,
              title: conversationTitleFromText(next.text),
              messageCount: 1,
              createdAt,
              updatedAt: createdAt,
              pinned: false,
            }, ...current.filter((session) => session.sessionId !== created.sessionId)])
            setProjects((current) => current.map((project) => project.id === next.projectId && !project.runIds.includes(created.sessionId)
              ? { ...project, runIds: [...project.runIds, created.sessionId] }
              : project))
            cacheProjectResult(next.projectId, [], [], { workspaceSessionId: sessionId, selectedRunId: undefined })
            setQueued((current) => current.map((item) =>
              item.scopeKey === next.scopeKey && !item.runId
                ? { ...item, workspaceSessionId: created.sessionId }
                : item,
            ))
            if (activeProjectIdRef.current === next.projectId) {
              setWorkspaceSessionId(sessionId)
              setWorkspaceInteraction(created.interaction)
            }
            result = await postWorkspaceMessage(sessionId, next.text, true, next.attachments, controller.signal)
            void refreshWorkspaceSessions()
            void refreshRuns()
          } else {
            result = await postWorkspaceMessage(sessionId, next.text, true, next.attachments, controller.signal)
          }
          cacheProjectResult(next.projectId, result.messages, [
            activeOptimisticMessageId,
            `${activeOptimisticMessageId}.attachments`,
          ], result.runId
            ? { selectedRunId: result.runId, workspaceSessionId: undefined }
            : { workspaceSessionId: sessionId, selectedRunId: undefined })
          if (activeProjectIdRef.current === next.projectId) {
            knownMessageIds.current.delete(activeOptimisticMessageId)
            knownMessageIds.current.delete(`${activeOptimisticMessageId}.attachments`)
            setMessages((current) => current.filter((message) =>
              message.messageId !== activeOptimisticMessageId &&
              message.messageId !== `${activeOptimisticMessageId}.attachments` &&
              !isTransientLocalError(message),
            ))
            const latest = [...result.messages].reverse().find((message) => message.role === 'assistant' && !message.messageKind.startsWith('activity.'))
            if (latest) {
              setLiveAssistantMessageId(latest.messageId)
            }
            mergeMessages(result.messages)
            setWorkspaceInteraction(result.interaction)
            setWorkspaceActivity(result.activity)
            setMemory(result.memory)
            setTokenUsage(result.tokenUsage)
            if (result.runId) {
              assignItemToProject(result.runId, next.projectId)
              preserveMessagesRunRef.current = result.runId
              setSelectedRunId(result.runId)
              setStatus(result.status)
              setWorkspaceSessionId(undefined)
            }
          }
          void refreshWorkspaceSessions()
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          const detail = error instanceof Error ? error.message : String(error)
          if (activeProjectIdRef.current === next.projectId) {
            const createdAt = new Date().toISOString()
            const errorMessage: WebMessage = {
              messageId: `local.error.${crypto.randomUUID()}`,
              role: 'assistant',
              messageKind: 'conversation.error',
              content: locale === 'zh-CN'
                ? `抱歉，这条消息暂时无法处理。\n\n原因：${detail === 'Failed to fetch' ? '无法连接到 THETA 本地服务，请确认服务已启动并允许当前页面访问。' : detail}\n\n你可以检查服务连接后重新发送。`
                : `Sorry, this message could not be processed.\n\nReason: ${detail}\n\nCheck the service connection and try again.`,
              sequenceNumber: 0,
              createdAt,
            }
            knownMessageIds.current.add(errorMessage.messageId)
            setMessages((current) => [...current, { ...errorMessage, sequenceNumber: Math.max(0, ...current.map((message) => message.sequenceNumber)) + 1 }])
          }
          setLoadError(undefined)
        }
      } finally {
        finishQueuedMessage(next.id)
      }
    })()
  }, [activateScope, assignItemToProject, cacheProjectResult, finishQueuedMessage, locale, mergeMessages, optimisticMessages, queued, refreshRuns, refreshWorkspaceSessions, selectedRunId, workspaceSessionId])

  useEffect(() => {
    if (!sending || selectedRunId || !workspaceSessionId) return
    let cancelled = false
    const poll = (): void => {
      const expectedScope = activeScopeRef.current
      void getWorkspaceConversation(workspaceSessionId)
        .then((conversation) => {
          if (cancelled || activeScopeRef.current !== expectedScope) return
          const activeItem = queued.find((item) => item.id === processingMessageRef.current)
          if (activeItem && conversation.messages.some((message) => message.role === 'user' && message.content === activeItem.text)) {
            const optimisticMessageId = activeItem.optimisticMessageId ?? `optimistic.${activeItem.id}`
            knownMessageIds.current.delete(optimisticMessageId)
            setMessages((current) => current.filter((message) => message.messageId !== optimisticMessageId))
          }
          const latest = [...conversation.messages].reverse().find((message) =>
            message.role === 'assistant' && !message.messageKind.startsWith('activity.'),
          )
          const queueId = processingMessageRef.current
          const receivedNewAssistant = latest != null && !knownMessageIds.current.has(latest.messageId)
          if (latest && receivedNewAssistant) setLiveAssistantMessageId(latest.messageId)
          mergeMessages(conversation.messages)
          if (conversation.status) setStatus(conversation.status)
          // The message request owns completion; stream snapshots may contain earlier replies.
          setMemory(conversation.memory)
          setTokenUsage(conversation.tokenUsage)
        })
        .catch(() => undefined)
    }
    poll()
    const timer = window.setInterval(poll, 400)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [finishQueuedMessage, sending, selectedRunId, workspaceSessionId, mergeMessages, queued])

  const assistantRendered = useCallback((messageId: string): void => {
    const pending = awaitingRenderRef.current
    if (!pending || pending.messageId !== messageId) return
    finishQueuedMessage(pending.queueId)
  }, [finishQueuedMessage])

  const stopSending = useCallback((): void => {
    const runId = selectedRunId ?? workspaceSessionId
    if (runId) {
      void stopRunGeneration(runId).catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error))
      })
    }
    activeRequestControllerRef.current?.abort()
    const queueId = processingMessageRef.current
    if (queueId) finishQueuedMessage(queueId)
  }, [finishQueuedMessage, selectedRunId, workspaceSessionId])

  useEffect(() => {
    const id = selectedRunId ?? workspaceSessionId
    if (!id) { setAnalysisModeBusy(false); return }
    let stale = false
    setAnalysisModeBusy(true)
    void getRun(id).then(detail => { if (!stale) setLocalAnalysisMode(detail.analysisMode ?? 'topic') })
      .catch(error => { if (!stale) toast.error(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!stale) setAnalysisModeBusy(false) })
    return () => { stale = true }
  }, [selectedRunId, workspaceSessionId])

  const changeAnalysisMode = async (mode: 'topic' | 'free') => {
    const id = selectedRunId ?? workspaceSessionId
    if (!id) { setLocalAnalysisMode(mode); return }
    const scope = activeScopeRef.current
    setAnalysisModeBusy(true)
    try { const result = await setAnalysisMode(id, mode); if (activeScopeRef.current === scope) setLocalAnalysisMode(result.analysisMode) }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
    finally { setAnalysisModeBusy(false) }
  }

  const startNewConversation = useCallback((projectId = activeProjectId) => {
    setWorkspaceMode('conversation')
    setLocalAnalysisMode('topic')
    activateScope(`draft:${crypto.randomUUID()}`)
    setActiveProjectId(projectId)
    activeProjectIdRef.current = projectId
    setSelectedRunId(undefined)
    setWorkspaceSessionId(undefined)
    setMessages([])
    setEvents([])
    setReasoning(undefined)
    setResults(undefined)
    setMemory(undefined)
    setTokenUsage(EMPTY_TOKEN_USAGE)
    setStatus(undefined)
    setRunDetail(undefined)
    setWorkspaceActivity(undefined)
    setWorkspaceInteraction(undefined)
    setAttachments([])
    setLiveAssistantMessageId(undefined)
    setLoadError(undefined)
    setManualDrafts((current) => ({ ...current, [projectId]: createManualWorkspaceDraft() }))
    knownMessageIds.current.clear()
  }, [activateScope, activeProjectId])

  const restoreLocalProject = useCallback((projectId: string): void => {
    const snapshot = projectMemoriesRef.current[projectId]
    const cachedMessages = withoutTransientLocalErrors(snapshot?.messages ?? [])
    activateScope(`draft:${projectId}:${crypto.randomUUID()}`)
    setActiveProjectId(projectId)
    setSelectedRunId(undefined)
    setWorkspaceSessionId(undefined)
    setMessages(cachedMessages)
    setEvents([])
    setReasoning(undefined)
    setResults(undefined)
    setMemory(undefined)
    setTokenUsage(EMPTY_TOKEN_USAGE)
    setStatus(undefined)
    setRunDetail(undefined)
    setWorkspaceActivity(undefined)
    setWorkspaceInteraction(snapshot?.interaction)
    setAttachments(snapshot?.attachments ?? [])
    setLiveAssistantMessageId(undefined)
    setLoadError(undefined)
    knownMessageIds.current.clear()
    cachedMessages.forEach((message) => knownMessageIds.current.add(message.messageId))
  }, [activateScope])

  const selectWorkspaceHistory = async (sessionId: string): Promise<void> => {
    const scopeKey = `workspace:${sessionId}:${crypto.randomUUID()}`
    const projectId = projectIdFor(sessionId)
    const snapshot = projectMemoriesRef.current[projectId]
    const conversationSnapshot = snapshot?.conversations?.[sessionId]
    const snapshotMatches = conversationSnapshot != null || snapshot?.workspaceSessionId === sessionId
    const cachedMessages = snapshotMatches
      ? withoutTransientLocalErrors(conversationSnapshot?.messages ?? snapshot?.messages ?? [])
      : []
    activateScope(scopeKey)
    setActiveProjectId(projectId)
    setSelectedRunId(undefined)
    setWorkspaceSessionId(sessionId)
    setMessages(cachedMessages)
    setStatus(undefined)
    setRunDetail(undefined)
    setEvents([])
    setReasoning(undefined)
    setResults(undefined)
    setWorkspaceActivity(undefined)
    setWorkspaceInteraction(undefined)
    setAttachments(snapshotMatches ? conversationSnapshot?.attachments ?? snapshot?.attachments ?? [] : [])
    setTokenUsage(EMPTY_TOKEN_USAGE)
    knownMessageIds.current.clear()
    cachedMessages.forEach((message) => knownMessageIds.current.add(message.messageId))
    try {
      const conversation = await getWorkspaceConversation(sessionId)
      if (activeScopeRef.current !== scopeKey) return
      setWorkspaceSessionId(sessionId)
      setWorkspaceInteraction(conversation.interaction)
      setMemory(conversation.memory)
      setTokenUsage(conversation.tokenUsage)
      mergeMessages(conversation.messages)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  const selectRunHistory = (run: Pick<WebRunSummary, 'runId'>, projectId: string): void => {
    const snapshot = projectMemoriesRef.current[projectId]
    const conversationSnapshot = snapshot?.conversations?.[run.runId]
    const snapshotMatches = conversationSnapshot != null || snapshot?.selectedRunId === run.runId
    const cachedMessages = snapshotMatches
      ? withoutTransientLocalErrors(conversationSnapshot?.messages ?? snapshot?.messages ?? [])
      : []
    activateScope(`run:${run.runId}:${crypto.randomUUID()}`)
    setActiveProjectId(projectId)
    setWorkspaceSessionId(undefined)
    setMessages(cachedMessages)
    setAttachments(snapshotMatches ? conversationSnapshot?.attachments ?? snapshot?.attachments ?? [] : [])
    setWorkspaceActivity(undefined)
    setWorkspaceInteraction(conversationSnapshot?.interaction ?? snapshot?.interaction)
    setSelectedRunId(run.runId)
    knownMessageIds.current.clear()
    cachedMessages.forEach((message) => knownMessageIds.current.add(message.messageId))
  }

  const openProject = (project: LocalProject): void => {
    const snapshot = projectMemoriesRef.current[project.id]
    const projectRunIds = new Set([
      ...project.runIds,
      ...Object.keys(snapshot?.conversations ?? {}),
    ])
    const projectRuns = runs
      .filter((run) => run.projectId === project.id || project.runIds.includes(run.runId))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    if (snapshot?.selectedRunId && projectRunIds.has(snapshot.selectedRunId)) {
      selectRunHistory({ runId: snapshot.selectedRunId }, project.id)
      return
    }
    if (snapshot?.workspaceSessionId && projectRunIds.has(snapshot.workspaceSessionId)) {
      void selectWorkspaceHistory(snapshot.workspaceSessionId)
      return
    }
    const session = workspaceSessions.find((item) => item.projectId === project.id || projectRunIds.has(item.sessionId))
    if (session) {
      void selectWorkspaceHistory(session.sessionId)
      return
    }
    const run = projectRuns[0]
    if (run) {
      selectRunHistory(run, project.id)
      return
    }
    const storedRunId = [...projectRunIds].at(-1)
    if (storedRunId) {
      selectRunHistory({ runId: storedRunId }, project.id)
      return
    }
    restoreLocalProject(project.id)
  }

  useEffect(() => {
    if (runsLoading) return
    const runId = restoreConversationRef.current
    restoreConversationRef.current = null
    if (!runId || activeProjectIdRef.current !== DRAFT_PROJECT_ID) return
    const run = runs.find((item) => item.runId === runId)
    if (run) selectRunHistory(run, run.projectId)
    else sessionStorage.removeItem(navigationKey)
  }, [runsLoading, runs, navigationKey])

  useEffect(() => {
    if (restoreConversationRef.current) return
    const runId = selectedRunId ?? workspaceSessionId
    if (runId) sessionStorage.setItem(navigationKey, runId)
    else sessionStorage.removeItem(navigationKey)
  }, [navigationKey, selectedRunId, workspaceSessionId])

  const deleteProject = async (): Promise<void> => {
    const target = projectToDelete
    if (!target || projectDeleteBusy) return
    setProjectDeleteBusy(true)
    setProjectDeleteError(undefined)
    try {
      await deleteProjectRequest(target.id)
      const targetRunIds = new Set([
        ...target.runIds,
        ...runs.filter((run) => run.projectId === target.id).map((run) => run.runId),
        ...workspaceSessions.filter((session) => session.projectId === target.id).map((session) => session.sessionId),
        ...Object.entries(projectAssignments)
          .filter(([, projectId]) => projectId === target.id)
          .map(([itemId]) => itemId),
      ])
      await Promise.all([...targetRunIds].map((runId) => deleteRun(runId)))
      setProjects((current) => current.filter((project) => project.id !== target.id))
      setProjectAssignments((current) => Object.fromEntries(
        Object.entries(current).filter(([, projectId]) => projectId !== target.id),
      ))
      setProjectMemories((current) => {
        const next = { ...current }
        delete next[target.id]
        return next
      })
      setManualDrafts((current) => {
        const next = { ...current }
        delete next[target.id]
        return next
      })
      setProjectToDelete(undefined)
      if (activeProjectId === target.id) startNewConversation(DRAFT_PROJECT_ID)
    } catch (error) {
      setProjectDeleteError(error instanceof Error ? error.message : String(error))
    } finally {
      setProjectDeleteBusy(false)
    }
  }

  const renameProject = async (): Promise<void> => {
    const target = projectToRename
    const displayName = projectRenameName.trim().replace(/\s+/gu, ' ')
    if (!target || !displayName || projectRenameBusy) return
    setProjectRenameBusy(true)
    setProjectRenameError(undefined)
    try {
      await renameProjectRequest(target.id, displayName)
      setProjects((current) => current.map((project) =>
        project.id === target.id ? { ...project, name: displayName } : project,
      ))
      setProjectToRename(undefined)
      setProjectRenameName('')
    } catch (error) {
      setProjectRenameError(error instanceof Error ? error.message : String(error))
    } finally {
      setProjectRenameBusy(false)
    }
  }

  const toggleProjectPin = async (project: LocalProject): Promise<void> => {
    setOpenProjectMenuId(undefined)
    try {
      const updated = await pinProjectRequest(project.id, !project.pinned)
      setProjects((current) => current.map((item) => item.id === project.id
        ? { ...item, pinned: updated.pinned }
        : item))
      toast.success(locale === 'zh-CN'
        ? (updated.pinned ? '项目已置顶' : '已取消项目置顶')
        : (updated.pinned ? 'Project pinned' : 'Project unpinned'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoadError(message)
      toast.error(message)
    }
  }

  const submitCreateProject = async (): Promise<void> => {
    const name = projectCreateName.trim().replace(/\s+/gu, ' ')
    if (!name || projectCreateBusy || !requireAuthentication()) return
    setProjectCreateBusy(true)
    setProjectCreateError(undefined)
    try {
      const created = await createProjectRequest(name)
      setProjects((current) => current.some((project) => project.id === created.id)
        ? current
        : [...current, { id: created.id, name: created.name, createdAt: created.createdAt, pinned: created.pinned, runIds: created.runIds }])
      setExpandedProjectIds((current) => new Set(current).add(created.id))
      setManualDrafts((current) => ({ ...current, [created.id]: createManualWorkspaceDraft() }))
      setProjectCreateOpen(false)
      setProjectCreateName('')
      startNewConversation(created.id)
      toast.success(locale === 'zh-CN' ? '项目已创建' : 'Project created')
    } catch (error) {
      setProjectCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setProjectCreateBusy(false)
    }
  }

  const submitCreateConversation = (targetProjectId = activeProjectId): void => {
    if (!requireAuthentication()) return
    if (targetProjectId !== DRAFT_PROJECT_ID) {
      setExpandedProjectIds((current) => new Set(current).add(targetProjectId))
    }
    startNewConversation(targetProjectId)
  }

  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId),
    [runs, selectedRunId],
  )
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId),
    [activeProjectId, projects],
  )
  const sortedProjects = useMemo(
    () => [...projects].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return Date.parse(right.createdAt) - Date.parse(left.createdAt)
    }),
    [projects],
  )
  const conversationsByProject = useMemo(() => {
    const grouped = new Map<string, WebWorkspaceSummary[]>()
    for (const session of workspaceSessions) {
      if (!session.projectId) continue
      const existing = grouped.get(session.projectId) ?? []
      existing.push(session)
      grouped.set(session.projectId, existing)
    }
    for (const sessions of grouped.values()) {
      sessions.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    }
    return grouped
  }, [workspaceSessions])
  const processingItem = queued.find((item) => item.id === processingMessageId)
  const activeSending = processingItem?.projectId === activeProjectId
  const activeManualOperation = manualOperation?.state === 'running' && (
    manualOperationProjectRef.current.get(manualOperation.id) === activeProjectId ||
    (manualOperation.runId != null && manualOperation.runId === selectedRunId)
  ) ? manualOperation : undefined
  const conversationInputDisabled = activeManualOperation != null ||
    ((processingMessageId != null || queued.length > 0) && !activeSending)

  const toggleSidebar = (): void => {
    setSidebarOpen((current) => {
      if (!current && window.matchMedia('(max-width: 900px)').matches) setDetailOpen(false)
      return !current
    })
  }

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    sidebarResizeStartRef.current = { pointerX: event.clientX, width: sidebarWidth }
    setSidebarResizing(true)
  }

  const resizeSidebar = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = sidebarResizeStartRef.current
    if (start == null) return
    const nextWidth = start.width + event.clientX - start.pointerX
    if (nextWidth <= SIDEBAR_COLLAPSE_THRESHOLD) {
      setSidebarOpen(false)
      return
    }
    setSidebarOpen(true)
    setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, nextWidth)))
  }

  const stopSidebarResize = (): void => {
    sidebarResizeStartRef.current = undefined
    setSidebarResizing(false)
  }

  const closeProjectMenu = (projectId: string): void => {
    setOpenProjectMenuId((current) => current === projectId ? undefined : current)
  }

  const selectProject = (project: LocalProject): void => {
    if (!requireAuthentication()) return
    setOpenProjectMenuId(undefined)
    const isExpanded = expandedProjectIds.has(project.id)
    setExpandedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(project.id)) next.delete(project.id)
      else next.add(project.id)
      return next
    })
    if (isExpanded) return
    if (activeProjectId === project.id && messagesRef.current.length > 0) return
    openProject(project)
  }

  const toggleDetail = (): void => {
    setDetailOpen((current) => {
      if (!current && window.matchMedia('(max-width: 900px)').matches) setSidebarOpen(false)
      return !current
    })
  }

  const hasTrainingStarted = /^(StartTraining|MonitorTraining)$/u.test(status?.currentState ?? '') ||
    events.some((event) => /training\.(started|progress|completed|failed)|训练(已)?(启动|进行|完成|失败)/iu.test(`${event.type} ${event.title}`))
  const hasResultArtifacts = results != null && (
    results.visualizations.length > 0 ||
    results.topics.length > 0 ||
    Object.keys(results.metrics).length > 0
  )
  const inspectorAvailable = selectedRunId != null && (hasTrainingStarted || hasResultArtifacts)
  const activeTitle = activeProject?.name ?? selectedRun?.identity?.displayName ?? selectedRun?.presentation?.title ??
    workspaceSessions.find((session) => session.sessionId === workspaceSessionId)?.title ??
    t('newChat')

  const manualRunCreated = (runId: string): void => {
    const previousProjectId = activeProjectId
    const projectId = activeProjectIdRef.current
    for (const [operationId, assignedProjectId] of manualOperationProjectRef.current) {
      if (assignedProjectId === previousProjectId) manualOperationProjectRef.current.set(operationId, projectId)
    }
    setManualDrafts((current) => {
      const carried = current[previousProjectId] ?? createManualWorkspaceDraft()
      const next = { ...current, [projectId]: { ...carried, pendingFile: undefined } }
      if (previousProjectId !== projectId) delete next[previousProjectId]
      return next
    })
    assignItemToProject(runId, projectId)
    activateScope(`run:${runId}:${crypto.randomUUID()}`)
    setActiveProjectId(projectId)
    setWorkspaceSessionId(undefined)
    setWorkspaceActivity(undefined)
    setWorkspaceInteraction(undefined)
    setSelectedRunId(runId)
    activeProjectIdRef.current = projectId
    setManualOperation((current) => current?.state === 'running' ? { ...current, runId } : current)
    const carriedMessages = messagesRef.current
    setProjectMemories((current) => {
      const previous = current[projectId] ?? { messages: [], attachments }
      return {
        ...current,
        [projectId]: {
          ...previous,
          messages: mergeStoredMessages(previous.messages, carriedMessages),
          attachments,
          selectedRunId: runId,
        },
      }
    })
    setEvents([])
    setReasoning(undefined)
    setResults(undefined)
    setRunDetail(undefined)
    setStatus(undefined)
    setLoadError(undefined)
    void refreshRuns()
  }

  const datasetReady = async (datasets: WebDataset[]): Promise<void> => {
    const dataset = datasets[0]
    if (!dataset) return
    const projectId = await ensureProject(dataset.name.replace(/\.[^.]+$/u, '') || '数据分析项目')

    const datasetAttachments: WebAttachment[] = [{ kind: 'dataset', id: dataset.datasetRef, label: dataset.name }]
    if (activeProjectIdRef.current === projectId) setAttachments(datasetAttachments)
    setProjectMemories((current) => {
      const previous = current[projectId] ?? { messages: messagesRef.current, attachments: [] }
      return { ...current, [projectId]: { ...previous, attachments: datasetAttachments } }
    })
    if (workspaceMode === 'conversation') {
      enqueue('请理解刚上传的数据，结合我们前面的目标说明可以怎样分析，先不要训练。', datasetAttachments, projectId)
      return
    }
    appendProjectNotice(projectId, '数据集已成功上传，现在 THETA 将读取数据结构、识别字段角色并核验基础质量；理解完成后会立即在这里展示结果。')

    const operation: ManualOperationStatus = {
      id: crypto.randomUUID(),
      action: 'inspect',
      label: '正在理解数据集',
      detail: 'THETA 正在读取数据结构、抽取样本并识别正文列、时间列和质量风险。',
      startedAt: new Date().toISOString(),
      state: 'running',
    }
    handleManualOperationChange(operation)

    try {
      const created = await createRun({ projectId, datasetRef: dataset.datasetRef, allowRemoteSamples: true })
      const runId = created.runId
      assignItemToProject(runId, projectId)
      cacheProjectResult(projectId, [], [], { selectedRunId: runId, workspaceSessionId: undefined })
      setProjectMemories((current) => {
        const previous = current[projectId] ?? { messages: [], attachments: datasetAttachments }
        return {
          ...current,
          [projectId]: { ...previous, attachments: datasetAttachments, selectedRunId: runId, workspaceSessionId: undefined },
        }
      })
      await runWorkflowAction(runId, 'discover')
      const [conversation, detail] = await Promise.all([getConversation(runId), getRun(runId)])
      cacheProjectResult(projectId, conversation.messages, [], { selectedRunId: runId, workspaceSessionId: undefined })
      handleManualOperationChange({
        ...operation,
        runId,
        state: 'completed',
        completedAt: new Date().toISOString(),
        completionDetail: '字段证据、内容特征、研究机会与风险已经完成初步审阅，结论可在当前对话中继续修订。',
      })
      if (activeProjectIdRef.current === projectId) {
        mergeMessages(conversation.messages)
        preserveMessagesRunRef.current = runId
        setSelectedRunId(runId)
        setWorkspaceSessionId(undefined)
        setWorkspaceActivity(undefined)
        setWorkspaceInteraction(undefined)
        setStatus(detail.status)
        setRunDetail(detail)
        setTokenUsage(conversation.tokenUsage)
      }
      void refreshRuns()
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      handleManualOperationChange({ ...operation, state: 'failed', completedAt: new Date().toISOString(), error: detail })
      appendProjectNotice(projectId, `数据集已成功上传，但本次自动理解没有完成：${detail}。数据集仍保留在当前项目中，可以稍后重试。`)
    }
  }

  const activeManualDraft = useMemo(() => {
    const defaults = createManualWorkspaceDraft()
    const current = manualDrafts[activeProjectId]
    return current == null ? defaults : {
      ...defaults,
      ...current,
      cleaning: { ...defaults.cleaning, ...current.cleaning },
      parameters: { ...defaults.parameters, ...current.parameters },
    }
  }, [activeProjectId, manualDrafts])
  const updateActiveManualDraft = useCallback((updater: ManualWorkspaceDraft | ((current: ManualWorkspaceDraft) => ManualWorkspaceDraft)): void => {
    setManualDrafts((current) => {
      const defaults = createManualWorkspaceDraft()
      const stored = current[activeProjectId]
      const existing = stored == null ? defaults : {
        ...defaults,
        ...stored,
        cleaning: { ...defaults.cleaning, ...stored.cleaning },
        parameters: { ...defaults.parameters, ...stored.parameters },
      }
      const next = typeof updater === 'function' ? updater(existing) : updater
      return { ...current, [activeProjectId]: next }
    })
  }, [activeProjectId])

  return (
    <div className={css.shell}>
      <div className={css.body}>
        {sidebarOpen && (
          <aside
            className={`${css.sidebar} ${sidebarResizing ? css.sidebarResizing : ''}`}
            style={{ width: sidebarWidth, minWidth: sidebarWidth }}
          >
            <div className={css.sidebarBrand}>
              <CatBrandWordmark className={css.sidebarBrandLogo} />
            </div>
            <div className={css.sidebarCreateActions}>
              <button
                type="button"
                className={css.projectCreateButton}
                onClick={() => {
                  if (!requireAuthentication()) return
                  setProjectCreateError(undefined)
                  setProjectCreateName('')
                  setProjectCreateOpen(true)
                }}
              >
                <img className={css.newProjectFolderIcon} src="/ui/project-folder-new.png" alt="" aria-hidden="true" />
                <span>{locale === 'zh-CN' ? '新建项目' : 'New project'}</span>
              </button>
              <button
                type="button"
                className={css.conversationCreateButton}
                onClick={() => void submitCreateConversation()}
              >
                <img className={css.newConversationIcon} src="/ui/workspace-conversation.png" alt="" aria-hidden="true" />
                <span>{locale === 'zh-CN' ? '新建对话' : 'New conversation'}</span>
              </button>
            </div>
            <div className={css.projectSectionHeading}>
              <span>{locale === 'zh-CN' ? '项目' : 'Projects'}</span>
              <small>{sortedProjects.length}</small>
            </div>
            <nav className={css.projectList} aria-label={locale === 'zh-CN' ? '项目' : 'Projects'}>
              {runsLoading && <div className={css.projectSyncing}>{locale === 'zh-CN' ? '正在同步项目…' : 'Syncing projects…'}</div>}
              {sortedProjects.map((project) => {
                const projectConversations = conversationsByProject.get(project.id) ?? []
                const projectExpanded = expandedProjectIds.has(project.id)
                return <div
                  key={project.id}
                  className={`${css.projectNode} ${activeProjectId === project.id ? css.projectNodeActive : ''} ${openProjectMenuId === project.id ? css.projectNodeMenuOpen : ''}`}
                  onMouseLeave={() => closeProjectMenu(project.id)}
                >
                  <div className={css.projectRow}>
                    <button
                      type="button"
                      className={css.projectEntry}
                      aria-current={activeProjectId === project.id ? 'page' : undefined}
                      aria-expanded={projectExpanded}
                      onClick={() => selectProject(project)}
                      title={project.name}
                    >
                      <img
                        className={css.projectIcon}
                        src="/ui/project-folder-new.png"
                        alt=""
                        aria-hidden="true"
                      />
                      <span>{project.name}</span>
                      {project.pinned && (
                        <span className={css.projectPinnedMark} aria-hidden="true">
                          <svg viewBox="0 0 16 16"><path d="M5 2h6l-1 4 2 2v1H9v5l-1 1-1-1V9H4V8l2-2-1-4Z" /></svg>
                        </span>
                      )}
                      <IconChevronDownOutline14 className={`${css.projectExpandChevron} ${projectExpanded ? css.projectExpandChevronOpen : ''}`} />
                    </button>
                    <div className={`${css.projectMenu} ${openProjectMenuId === project.id ? css.projectMenuOpen : ''}`}>
                      <button
                        type="button"
                        className={css.projectMenuTrigger}
                        aria-expanded={openProjectMenuId === project.id}
                        aria-label={`${project.name} - ${locale === 'zh-CN' ? '项目操作' : 'Project actions'}`}
                        onClick={() => setOpenProjectMenuId((current) => current === project.id ? undefined : project.id)}
                      >
                        <IconEllipsisOutline16 />
                      </button>
                      {openProjectMenuId === project.id && (
                        <div className={css.projectMenuPopover} onMouseLeave={() => closeProjectMenu(project.id)}>
                          <button
                            type="button"
                            className={css.projectRenameAction}
                            onClick={() => void toggleProjectPin(project)}
                          >
                            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 2h6l-1 4 2 2v1H9v5l-1 1-1-1V9H4V8l2-2-1-4Z" /></svg>
                            {locale === 'zh-CN' ? (project.pinned ? '取消置顶' : '置顶项目') : (project.pinned ? 'Unpin project' : 'Pin project')}
                          </button>
                          <button
                            type="button"
                            className={css.projectRenameAction}
                            onClick={() => {
                              setOpenProjectMenuId(undefined)
                              setProjectRenameError(undefined)
                              setProjectRenameName(project.name)
                              setProjectToRename(project)
                            }}
                          >
                            <IconEditOutline16 />{locale === 'zh-CN' ? '修改名称' : 'Rename'}
                          </button>
                          <button type="button" onClick={() => { setOpenProjectMenuId(undefined); setProjectDeleteError(undefined); setProjectToDelete(project) }}>
                            <IconTrashOutline16 />{locale === 'zh-CN' ? '删除项目' : 'Delete project'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {projectExpanded && <div className={css.projectConversationList}>
                    {projectConversations.map((session) => {
                      const active = workspaceSessionId === session.sessionId || selectedRunId === session.sessionId
                      return (
                        <div
                          key={session.sessionId}
                          className={`${css.conversationNode} ${active ? css.conversationNodeActive : ''}`}
                        >
                          <button
                            type="button"
                            className={css.conversationEntry}
                            aria-current={active ? 'page' : undefined}
                            onClick={() => void selectWorkspaceHistory(session.sessionId)}
                            title={session.title}
                          >
                            <span>{session.title}</span>
                            <small>{session.messageCount}</small>
                          </button>
                        </div>
                      )
                    })}
                    <div className={css.conversationNode}>
                      <button
                        type="button"
                        className={css.conversationEntry}
                        onClick={() => void submitCreateConversation(project.id)}
                      >
                        <span>{locale === 'zh-CN' ? '新建对话' : 'New conversation'}</span>
                        <small>＋</small>
                      </button>
                    </div>
                  </div>}
                </div>
              })}
            </nav>
            <div className={css.sidebarFooter}>
              {OPEN_SOURCE_EDITION ? <span className={css.sidebarIdentity}><strong>THETA Open Source</strong><small>{locale === 'zh-CN' ? '本地工作台' : 'Local workbench'}</small></span> : <div className={css.accountMenu} data-account-menu>
                <button
                  type="button"
                  className={css.accountMenuTrigger}
                  aria-expanded={accountMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setAccountMenuOpen((current) => !current)}
                >
                  <span className={css.userAvatar}>U</span>
                  <span className={css.sidebarIdentity}>
                    <strong>{user?.username ?? accountName}</strong>
                    <small>{locale === 'zh-CN' ? '账号管理' : 'Account management'}</small>
                  </span>
                  <IconChevronDownOutline14 className={css.accountMenuChevron} />
                </button>
                {accountMenuOpen && (
                  <div className={css.accountMenuPopover} role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAccountMenuOpen(false)
                        toast.info(locale === 'zh-CN' ? '该功能正在开发中' : 'This feature is under development', { duration: 5000 })
                      }}
                    >
                      {locale === 'zh-CN' ? '账号详情' : 'Account details'}
                    </button>
                    <button type="button" role="menuitem" onClick={() => { void logout() }}>
                      {locale === 'zh-CN' ? '退出登录' : 'Log out'}
                    </button>
                  </div>
                )}
              </div>}
              <button type="button" className={css.sidebarSettings} onClick={() => setSettingsOpen(true)} aria-label={locale === 'zh-CN' ? '打开设置' : 'Open settings'}>
                <IconSettingsOutline16 />
              </button>
            </div>
            <div
              className={css.sidebarResizeHandle}
              role="separator"
              aria-label={locale === 'zh-CN' ? '调整侧边栏宽度' : 'Resize sidebar'}
              aria-orientation="vertical"
              onPointerDown={startSidebarResize}
              onPointerMove={resizeSidebar}
              onPointerUp={stopSidebarResize}
              onPointerCancel={stopSidebarResize}
              onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
            />
          </aside>
        )}

        <main className={css.center}>
          <div className={css.workspaceModeBar}>
            <div className={css.workspaceNavigation}>
              {!sidebarOpen && (
                <Button
                  size="sm"
                  variant="ghost"
                  className={css.iconButton}
                  aria-label={locale === 'zh-CN' ? '展开侧边栏' : 'Show sidebar'}
                  onClick={toggleSidebar}
                >
                  <IconPanelLeftOutline16 />
                </Button>
              )}
              <a className={css.homeLink} href={HOME_URL} aria-label={locale === 'zh-CN' ? '返回首页' : 'Back to home'}>
                <IconChevronLeftOutline14 />
                <span>{locale === 'zh-CN' ? '返回首页' : 'Home'}</span>
              </a>
            </div>
            <div className={css.workspaceModeSwitch} role="group" aria-label="工作台模式">
              <button type="button" aria-pressed={workspaceMode === 'conversation'} className={workspaceMode === 'conversation' ? css.workspaceModeActive : undefined} onClick={() => setWorkspaceMode('conversation')}>
                <span className={css.workspaceModeIcon} aria-hidden="true">
                  <img src="/ui/workspace-conversation.png" alt="" />
                </span>
                <span className={css.workspaceModeCopy}>
                  <strong>对话</strong>
                  <small>探索、分析与生成</small>
                </span>
              </button>
              <button type="button" aria-pressed={workspaceMode === 'manual'} className={workspaceMode === 'manual' ? css.workspaceModeActive : undefined} onClick={() => setWorkspaceMode('manual')}>
                <span className={css.workspaceModeIcon} aria-hidden="true">
                  <img src="/ui/workspace-manual.png" alt="" />
                </span>
                <span className={css.workspaceModeCopy}>
                  <strong>手动</strong>
                  <small>流程化精细控制</small>
                </span>
              </button>
            </div>
          </div>
          {(selectedRunId != null || workspaceSessionId != null || messages.length > 0 || activeSending) && (
            <div className={css.centerHeader}>
              {sidebarOpen && (
                <Button size="sm" variant="ghost" className={css.iconButton} aria-label="收起任务列表" onClick={toggleSidebar}>
                  <IconPanelLeftOutline16 />
                </Button>
              )}
              <strong>{activeTitle || t('newChat')}</strong>
              <IconChevronUpOutline14 className={css.headerChevron} />
              <div className={css.headerActions}>
                <button type="button" aria-label={locale === 'zh-CN' ? '分享' : 'Share'}><IconShareOutline16 /></button>
                <span className={css.userAvatar}>U</span>
              </div>
              {inspectorAvailable && (
                <Button size="sm" variant="ghost" className={`${css.iconButton} ${detailOpen ? css.detailToggleActive : ''}`} aria-label={detailOpen ? '收起训练详情' : '展开训练详情'} onClick={toggleDetail}>
                  <IconPanelLeftOutline16 className={css.flipIcon} />
                </Button>
              )}
            </div>
          )}
          {workspaceMode === 'manual' ? (
            <div className={css.manualWorkbenchSplit}>
              <ManualWorkspace
                runId={selectedRunId}
                onEnsureProject={ensureProject}
                status={status}
                detail={runDetail}
                reasoning={reasoning}
                events={events}
                results={results}
                loading={runsLoading || streamState === 'connecting'}
                error={loadError}
                draft={activeManualDraft}
                onDraftChange={updateActiveManualDraft}
                onCreated={manualRunCreated}
                onRefresh={() => void refreshRun()}
                activeOperation={activeManualOperation}
                onOperationChange={handleManualOperationChange}
                onConversationMessages={mergeManualConversationMessages}
                onConversationNotice={appendConversationNotice}
                conversationAttachments={attachments}
                conversationMessages={messages}
                capturedActivity={workspaceActivity}
              />
              <aside className={css.manualConversationRail} aria-label="THETA 项目对话">
                <div className={css.manualConversationHeader}><strong>THETA 指引</strong><span>同一项目</span></div>
                <ConversationPane
                  analysisMode={analysisMode}
                  onAnalysisModeChange={changeAnalysisMode}
                  analysisModeDisabled={analysisModeBusy || queued.length > 0}
                  compact
                  projectStorageScope={activeProjectId}
                  projectName={activeProject?.name ?? t('newChat')}
                  messages={messages}
                  sending={activeSending}
                  inputDisabled={conversationInputDisabled}
                  onSend={sendMessage}
                  workspaceSessionId={workspaceSessionId}
                  entryInteraction={workspaceInteraction ?? runtimeProfile?.entryInteraction}
                  workspaceActivity={workspaceActivity}
                  runId={selectedRunId}
                  status={status}
                  reasoning={reasoning}
                  onApproved={() => void refreshRun()}
                  attachments={attachments}
                  onAttachmentsChange={setAttachments}
                  onEnsureProject={ensureProject}
                  onDatasetReady={datasetReady}
                  liveAssistantMessageId={liveAssistantMessageId}
                  onAssistantRendered={assistantRendered}
                  tokenUsage={tokenUsage}
                  activeOperation={activeManualOperation}
                />
              </aside>
            </div>
          ) : runsLoading && selectedRunId == null
            ? (
              <div className={css.catalogLoading}>
                <span />
                <strong>正在恢复研究工作区</strong>
                <small>读取本地任务、对话与 Agent 状态</small>
              </div>
            )
            : (
              <ConversationPane
                  analysisMode={analysisMode}
                  onAnalysisModeChange={changeAnalysisMode}
                  analysisModeDisabled={analysisModeBusy || queued.length > 0}
                projectStorageScope={activeProjectId}
                projectName={activeProject?.name ?? t('newChat')}
                starterProjectName={activeProject?.name}
                messages={messages}
                sending={activeSending}
                inputDisabled={conversationInputDisabled}
                onSend={sendMessage}
                onStop={stopSending}
                workspaceSessionId={workspaceSessionId}
                entryInteraction={workspaceInteraction ?? runtimeProfile?.entryInteraction}
                workspaceActivity={workspaceActivity}
                runId={selectedRunId}
                status={status}
                reasoning={reasoning}
                onApproved={() => void refreshRun()}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                onEnsureProject={ensureProject}
                onDatasetReady={datasetReady}
                liveAssistantMessageId={liveAssistantMessageId}
                onAssistantRendered={assistantRendered}
                tokenUsage={tokenUsage}
                activeOperation={activeManualOperation}
              />
            )}
        </main>

        {workspaceMode === 'conversation' && detailOpen && inspectorAvailable && selectedRunId != null && (
          <DetailPane
            runId={selectedRunId}
            status={status}
            events={events}
            results={results}
            plan={runDetail?.plan}
            onAttach={(attachment) => {
              setAttachments((current) => [...current.filter((item) => item.id !== attachment.id), attachment].slice(-12))
            }}
          />
        )}
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onAccountNameChange={setAccountName} />
      <Modal
        open={projectCreateOpen}
        onClose={() => { if (!projectCreateBusy) setProjectCreateOpen(false) }}
        title={locale === 'zh-CN' ? '新建项目' : 'Create project'}
        description={locale === 'zh-CN' ? '创建一个独立项目，用于组织相关对话、数据和运行记录。' : 'Create a project for related conversations, data, and runs.'}
        className={css.createProjectDialog}
        footer={(
          <>
            <Button variant="ghost" disabled={projectCreateBusy} onClick={() => setProjectCreateOpen(false)}>{locale === 'zh-CN' ? '取消' : 'Cancel'}</Button>
            <Button variant="primary" className={css.createProjectConfirm} disabled={projectCreateBusy || !projectCreateName.trim()} onClick={() => void submitCreateProject()}>
              {projectCreateBusy ? '…' : (locale === 'zh-CN' ? '创建' : 'Create')}
            </Button>
          </>
        )}
      >
        <label className={css.createProjectField}>
          <span>{locale === 'zh-CN' ? '项目名称' : 'Project name'}</span>
          <input
            autoFocus
            maxLength={120}
            value={projectCreateName}
            onChange={(event) => setProjectCreateName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submitCreateProject() }}
          />
        </label>
        {projectCreateError && <p className={css.projectDeleteError} role="alert">{projectCreateError}</p>}
      </Modal>
      <Modal
        open={projectToRename != null}
        onClose={() => { if (!projectRenameBusy) setProjectToRename(undefined) }}
        title={locale === 'zh-CN' ? '修改项目名称' : 'Rename project'}
        description={locale === 'zh-CN' ? '项目名称仅用于左侧项目列表和当前工作台标题。' : 'The name is used in the project list and workspace title.'}
        className={css.createProjectDialog}
        footer={(
          <>
            <Button variant="ghost" disabled={projectRenameBusy} onClick={() => setProjectToRename(undefined)}>{locale === 'zh-CN' ? '取消' : 'Cancel'}</Button>
            <Button variant="primary" className={css.createProjectConfirm} disabled={projectRenameBusy || !projectRenameName.trim()} onClick={() => void renameProject()}>
              {projectRenameBusy ? '…' : (locale === 'zh-CN' ? '保存' : 'Save')}
            </Button>
          </>
        )}
      >
        <label className={css.createProjectField}>
          <span>{locale === 'zh-CN' ? '项目名称' : 'Project name'}</span>
          <input
            autoFocus
            maxLength={120}
            value={projectRenameName}
            onChange={(event) => setProjectRenameName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void renameProject() }}
          />
        </label>
        {projectRenameError && <p className={css.projectDeleteError} role="alert">{projectRenameError}</p>}
      </Modal>
      <Modal
        open={projectToDelete != null}
        onClose={() => { if (!projectDeleteBusy) setProjectToDelete(undefined) }}
        title={locale === 'zh-CN' ? '删除项目' : 'Delete project'}
         description={locale === 'zh-CN' ? '项目及其下的全部对话、消息和运行记录将被永久删除。' : 'The project and all conversations, messages, and run records in it will be permanently deleted.'}
        className={css.createProjectDialog}
        footer={(
          <>
            <Button variant="ghost" disabled={projectDeleteBusy} onClick={() => setProjectToDelete(undefined)}>{locale === 'zh-CN' ? '取消' : 'Cancel'}</Button>
            <Button variant="primary" className={css.projectDeleteConfirm} disabled={projectDeleteBusy} onClick={() => void deleteProject()}>
              {projectDeleteBusy ? '…' : (locale === 'zh-CN' ? '删除' : 'Delete')}
            </Button>
          </>
        )}
      >
        <div className={css.projectDeleteBody}>
          <strong>{projectToDelete?.name}</strong>
          <p>{locale === 'zh-CN' ? '删除后无法恢复，服务端和当前浏览器中的记录都会清除。' : 'This cannot be undone. Server and browser records will be removed.'}</p>
          {projectDeleteError && <p className={css.projectDeleteError} role="alert">{projectDeleteError}</p>}
        </div>
      </Modal>
    </div>
  )
}
