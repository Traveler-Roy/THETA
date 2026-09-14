
import { OPEN_SOURCE_EDITION } from '@/lib/edition'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

interface RouteContext {
  params: Promise<{ path: string[] }>
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300
const SESSION_COOKIE = 'theta_session'

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, context)
}

export async function HEAD(request: NextRequest, context: RouteContext) {
  return proxy(request, context)
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, context)
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxy(request, context)
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxy(request, context)
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, context)
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 })
}

async function proxy(request: NextRequest, context: RouteContext) {
  if (OPEN_SOURCE_EDITION) return NextResponse.json({detail:'Account services are not part of the open-source edition.'},{status:404});
  const { path } = await context.params
  const localAuthResponse = await handleLocalAuth(request, path)
  if (localAuthResponse) return localAuthResponse

  const isAuthRequest = path[0] === 'api' && path[1] === 'auth'
  const isAgentRequest = path[0] === 'api' && ['auth', 'admin'].includes(path[1] ?? '')
  const baseUrl = isAgentRequest
    ? process.env.THETA_AGENT_API_URL?.trim()
      || (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:4318' : undefined)
    : process.env.THETA_LEGACY_API_URL?.trim()
      || 'https://theta-backend-nu.vercel.app'
  if (!baseUrl) {
    return NextResponse.json(
      {
        detail: isAgentRequest
          ? 'THETA_AGENT_API_URL 未配置，无法使用 MySQL 用户服务。'
          : 'THETA_LEGACY_API_URL 未配置。',
        code: 'THETA_BACKEND_NOT_CONFIGURED',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const target = new URL(
    `/${path.map(encodeURIComponent).join('/')}`,
    ensureTrailingSlash(baseUrl),
  )
  target.search = request.nextUrl.search

  const headers = new Headers()
  for (const name of [
    'accept',
    'authorization',
    'content-type',
    'range',
    'user-agent',
    'x-forwarded-for',
    'x-forwarded-proto',
  ]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const sessionToken = request.cookies.get(SESSION_COOKIE)?.value
  if (!headers.has('authorization') && sessionToken) {
    headers.set('authorization', `Bearer ${sessionToken}`)
  }

  try {
    const upstream = await fetch(target, streamingRequestInit(request, headers))
    if (isAuthRequest && path[2] === 'login' && upstream.ok) {
      const payload = await upstream.json() as Record<string, unknown>
      const token = typeof payload.access_token === 'string' ? payload.access_token : ''
      if (!token) {
        return NextResponse.json({ detail: '登录服务未返回有效会话。' }, { status: 502 })
      }
      const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 86_400
      const result = NextResponse.json({ ...payload, access_token: 'http-only-cookie' }, {
        status: upstream.status,
        headers: responseHeaders(upstream),
      })
      setSessionCookie(result, token, expiresIn, request)
      return result
    }
    const result = new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream),
    })
    if (isAuthRequest && path[2] === 'logout') clearSessionCookie(result, request)
    return result
  } catch {
    return NextResponse.json(
      {
        detail: '无法连接已部署的 THETA 后端。',
        code: 'THETA_BACKEND_UNAVAILABLE',
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}

type StreamingRequestInit = RequestInit & { duplex?: 'half' }

function streamingRequestInit(request: NextRequest, headers: Headers): StreamingRequestInit {
  const hasBody = !['GET', 'HEAD'].includes(request.method) && request.body !== null
  return {
    method: request.method,
    cache: 'no-store',
    headers,
    body: hasBody ? request.body : undefined,
    signal: request.signal,
    redirect: 'manual',
    ...(hasBody ? { duplex: 'half' as const } : {}),
  }
}

async function handleLocalAuth(request: NextRequest, path: string[]) {
  // Keep the mock account opt-in so local workbench requests use the real
  // Agent API identity by default.
  const enabled = process.env.THETA_LOCAL_AUTH_ENABLED === 'true'
  if (!enabled) return null

  const endpoint = `/${path.join('/')}`
  const username = process.env.THETA_LOCAL_TEST_USERNAME?.trim() || 'theta_test'
  const password = process.env.THETA_LOCAL_TEST_PASSWORD || 'ThetaLocal2026!'
  const user = {
    id: 1,
    username,
    email: 'theta-test@localhost',
    full_name: 'THETA Local Tester',
    created_at: '2026-01-01T00:00:00.000Z',
    is_active: true,
    role: 'tester',
  }

  if (endpoint === '/api/auth/login' && request.method === 'POST') {
    const form = new URLSearchParams(await request.text())
    if (form.get('username') !== username || form.get('password') !== password) {
      return NextResponse.json({ detail: '用户名或密码错误' }, { status: 401 })
    }

    const payload = Buffer.from(JSON.stringify({
      sub: username,
      id: user.id,
      username,
      email: user.email,
      role: user.role,
      local: true,
    })).toString('base64')
    const token = `theta-local.${payload}.development`
    const result = NextResponse.json({
      access_token: 'http-only-cookie',
      token_type: 'bearer',
      expires_in: 86_400,
      user,
    })
    setSessionCookie(result, token, 86_400, request)
    return result
  }

  if (endpoint === '/api/auth/logout' && request.method === 'POST') {
    const result = NextResponse.json({ message: '已退出本地内测账号' })
    clearSessionCookie(result, request)
    return result
  }

  if (endpoint === '/api/auth/me' && request.method === 'GET') {
    if (!request.cookies.get(SESSION_COOKIE)?.value) {
      return NextResponse.json({ detail: '请先登录。' }, { status: 401 })
    }
    return NextResponse.json(user)
  }

  if (endpoint === '/api/auth/verify' && request.method === 'POST') {
    if (!request.cookies.get(SESSION_COOKIE)?.value) {
      return NextResponse.json({ valid: false }, { status: 401 })
    }
    return NextResponse.json({ valid: true, username, user_id: user.id, role: user.role })
  }

  return null
}

function responseHeaders(response: Response) {
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  for (const name of [
    'accept-ranges',
    'content-disposition',
    'content-range',
    'content-type',
    'location',
    'set-cookie',
  ]) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

function ensureTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`
}

function setSessionCookie(
  response: NextResponse,
  token: string,
  maxAge: number,
  request: NextRequest,
) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttpsRequest(request),
    sameSite: 'lax',
    path: '/',
    maxAge,
  })
}

function clearSessionCookie(response: NextResponse, request: NextRequest) {
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: isHttpsRequest(request),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}

function isHttpsRequest(request: NextRequest) {
  return request.nextUrl.protocol === 'https:'
    || request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
}
