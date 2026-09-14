/**
 * THETA Backend API Client - 适配后端已有 API
 *
 * 所有 API 路径通过 endpoints-config.ts 集中管理，支持多环境切换
 * 详细接口文档见 theta_project/docs/API.md
 */

import { API_BASE, apiFetch as sharedApiFetch } from './config';
import { API_ENDPOINTS, buildUrl } from './endpoints-config';

const USER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function apiFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
  return sharedApiFetch<T>(API_BASE, endpoint, options);
}

// ==================== 类型定义 ====================

export interface STSResponse {
  credentials: {
    access_key_id: string;
    access_key_secret: string;
    security_token?: string;
    expiration: string;
  };
  upload_path: string;
  bucket: string;
  endpoint: string;
  region: string;
  provider?: string;
  object_key?: string;
  upload_url?: string;
  method?: string;
  headers?: Record<string, string>;
  public_url?: string;
}

export interface UploadCompleteResponse {
  id: number;
  filename: string;
  file_path: string;
  file_type: string;
  created_at: string;
}

export interface TrainStartResponse {
  id: number;
  user_id: number;
  status: string;
  dlc_job_id: string;
  created_at: string;
}

export interface TrainStatusResponse {
  job_id: number;
  file_id?: number;
  dataset_name?: string;
  status: 'pending' | 'creating' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  dlc_job_id?: string;
  error_message?: string;
  created_at: string;
  message?: string;
  model_type?: string;
  model_size?: string;
  num_topics?: number;
  mode?: string;
}

export interface TrainJobResponse {
  id: number;
  user_id: number;
  file_id?: number;
  dataset_name?: string;
  status: TrainStatusResponse['status'];
  dlc_job_id?: string;
  run_id?: string;
  error_message?: string;
  created_at: string;
  model_type?: string;
  model_size?: string;
  num_topics?: number;
  epochs?: number;
  batch_size?: number;
  learning_rate?: number;
  hidden_dim?: number;
  patience?: number;
  vocab_size?: number;
  mode?: string;
  language?: string;
}

export interface TrainMetricsResponse {
  job_id: number;
  status?: string;
  metrics: {
    coherence?: number;
    diversity?: number;
    perplexity?: number;
    [key: string]: number | null | undefined;
  };
  epochs?: number[];
  loss?: number[];
  accuracy?: number[];
}

export interface TrainSummaryResponse {
  job_id: number;
  summary: {
    num_topics: number;
    top_words: string[][];
  };
}

// ==================== 训练参数 ====================

export interface TrainParams {
  file_id: number;
  dataset_name: string;
  model_type?: string;
  model_size?: string;
  mode?: string;
  num_topics?: number;
  epochs?: number;
  batch_size?: number;
  learning_rate?: number;
  hidden_dim?: number;
  patience?: number;
  language?: string;
  vocab_size?: number;
}

// ==================== API ====================

export const BackendAPI = {
  // ========== 认证 ==========

  /**
   * 用户注册
   * POST /api/auth/register
   */
  async register(username: string, email: string, password: string): Promise<any> {
    return apiFetch(API_ENDPOINTS.auth.register, {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    });
  },

  /**
   * 用户登录
   * POST /api/auth/login (form-urlencoded)
   */
  async login(username: string, password: string): Promise<{ access_token: string; token_type: string }> {
    const form = new URLSearchParams();
    form.set('username', username);
    form.set('password', password);

    const response = await fetch(`${API_BASE}${API_ENDPOINTS.auth.login}`, {
      method: 'POST',
      body: form.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${response.status}`);
    }

    return response.json();
  },

  /**
   * 获取当前用户
   * GET /api/auth/me
   */
  async getCurrentUser(): Promise<any> {
    return apiFetch(API_ENDPOINTS.auth.me);
  },

  // ========== 文件上传 ==========

  /**
   * 获取 STS 凭证
   * GET /api/oss/sts-token?dataset_name=X
   */
  async getSTSToken(datasetName: string, file?: File): Promise<STSResponse> {
    const params = new URLSearchParams({ dataset_name: datasetName });
    if (file) {
      params.set('filename', file.name);
      params.set('content_type', file.type || 'application/octet-stream');
    }
    const url = `${API_ENDPOINTS.upload.sts_token}?${params.toString()}`;
    return apiFetch(url);
  },

  /**
   * 通知上传完成
   * POST /api/upload/complete
   */
  async uploadComplete(datasetName: string, filename: string, ossPath: string): Promise<UploadCompleteResponse> {
    return apiFetch(API_ENDPOINTS.upload.complete, {
      method: 'POST',
      body: JSON.stringify({
        dataset_name: datasetName,
        filename,
        oss_path: ossPath,
      }),
    });
  },

  /**
   * 获取用户文件列表
   * GET /api/files
   */
  async getFiles(): Promise<any[]> {
    return apiFetch(API_ENDPOINTS.upload.files);
  },

  // ========== 训练 ==========

  /**
   * 提交训练任务
   * POST /api/train/start
   */
  async startTraining(params: TrainParams): Promise<TrainStartResponse> {
    return apiFetch(API_ENDPOINTS.training.start, {
      method: 'POST',
      body: JSON.stringify({
        file_id: params.file_id,
        dataset_name: params.dataset_name,
        model_type: params.model_type || 'theta',
        model_size: params.model_size || '0.6B',
        mode: params.mode || 'zero_shot',
        num_topics: params.num_topics || 20,
        epochs: params.epochs || 100,
        batch_size: params.batch_size || 64,
        learning_rate: params.learning_rate || 0.002,
        hidden_dim: params.hidden_dim || 512,
        patience: params.patience || 10,
        language: params.language || 'chinese',
        vocab_size: params.vocab_size || 5000,
      }),
    });
  },

  /**
   * 查询训练状态
   * GET /api/train/{job_id}/status
   */
  async getTrainStatus(jobId: number): Promise<TrainStatusResponse> {
    return apiFetch(buildUrl('training', 'status', { job_id: jobId }));
  },

  /**
   * 取消训练任务
   * POST /api/train/{job_id}/cancel
   */
  async cancelTraining(jobId: number): Promise<{ success: boolean; message: string; status: string }> {
    return apiFetch(`/api/train/${jobId}/cancel`, {
      method: 'POST',
    });
  },

  /**
   * 获取训练任务列表
   * GET /api/train/jobs
   */
  async getTrainJobs(): Promise<TrainJobResponse[]> {
    return apiFetch(API_ENDPOINTS.training.jobs);
  },

  /**
   * 获取训练指标
   * GET /api/train/{job_id}/metrics
   */
  async getTrainMetrics(jobId: number): Promise<TrainMetricsResponse> {
    return apiFetch(buildUrl('training', 'metrics', { job_id: jobId }));
  },

  /**
   * 获取训练摘要
   * GET /api/train/{job_id}/summary
   */
  async getTrainSummary(jobId: number): Promise<TrainSummaryResponse> {
    return apiFetch(`/api/train/${jobId}/summary`);
  },

  // ========== OSS 直传 ==========

  /**
   * 使用 STS 凭证上传文件到 OSS (通过 ali-oss SDK)
   */
  async uploadToOSS(
    file: File,
    sts: STSResponse,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const { credentials, upload_path, bucket, endpoint } = sts;
    const objectKey = `${upload_path}${file.name}`;

    onProgress?.(10);

    if (sts.upload_url) {
      const headers = sts.headers || { 'Content-Type': file.type || 'application/octet-stream' };
      const response = await fetch(sts.upload_url, {
        method: sts.method || 'PUT',
        headers,
        body: file,
      });
      if (!response.ok) {
        throw new Error(`R2 upload failed (HTTP ${response.status})`);
      }
      onProgress?.(100);
      return;
    }

    // 动态导入 ali-oss（仅在浏览器环境）
    let OSS: any;
    if (typeof window !== 'undefined') {
      OSS = (await import('ali-oss')).default;
    } else {
      throw new Error('OSS 上传只能在浏览器环境执行');
    }

    const client = new OSS({
      region: endpoint.replace('.aliyuncs.com', ''),
      accessKeyId: credentials.access_key_id,
      accessKeySecret: credentials.access_key_secret,
      stsToken: credentials.security_token,
      bucket: bucket,
    });

    // 如果 security_token 为空，删除该字段
    if (!credentials.security_token) {
      delete (client as any).stsToken;
    }

    onProgress?.(20);

    try {
      const result = await client.put(objectKey, file, {
        progress: (p: number) => {
          if (onProgress) {
            onProgress(20 + Math.round(p * 75));
          }
        },
      });

      onProgress?.(100);

      if (result.res && result.res.status !== 200) {
        throw new Error(`OSS 上传失败 (HTTP ${result.res.status})`);
      }

      return;
    } catch (error: any) {
      console.error('OSS upload error:', error);
      throw new Error(`OSS 上传失败: ${error.message}`);
    }
  },
};

// ==================== 简化版 ETMAgentAPI 适配器 ====================
// 用于替换 etm-agent.ts 中调用不存在路由的函数

export const SimpleETMAPI = {
  /**
   * 获取 STS 凭证并上传文件到 OSS
   */
  async uploadDataset(
    file: File,
    datasetName: string,
    onProgress?: (progress: number) => void,
  ): Promise<{ file_id: number; dataset_name: string; oss_path: string }> {
    // 1. 获取 STS 凭证
    onProgress?.(5);
    const sts = await BackendAPI.getSTSToken(datasetName, file);

    // 2. 上传到 OSS
    onProgress?.(10);
    await BackendAPI.uploadToOSS(file, sts, onProgress);

    // 3. 通知上传完成
    onProgress?.(95);
    const ossPath = sts.object_key || `${sts.upload_path}${file.name}`;
    const result = await BackendAPI.uploadComplete(datasetName, file.name, ossPath);

    return {
      file_id: result.id,
      dataset_name: datasetName,
      oss_path: ossPath,
    };
  },

  /**
   * 提交训练任务
   */
  async startTraining(params: TrainParams): Promise<{ job_id: number; status: string }> {
    const result = await BackendAPI.startTraining(params);
    return {
      job_id: result.id,
      status: result.status,
    };
  },

  /**
   * 轮询训练状态直到完成
   */
  async pollTraining(
    jobId: number,
    onProgress?: (status: TrainStatusResponse) => void,
    interval = 5000,
    timeout = 3600000,
  ): Promise<TrainStatusResponse> {
    const start = Date.now();

    while (true) {
      const status = await BackendAPI.getTrainStatus(jobId);
      onProgress?.(status);

      if (['succeeded', 'failed', 'cancelled'].includes(status.status)) {
        return status;
      }

      if (Date.now() - start > timeout) {
        throw new Error('训练轮询超时');
      }

      await new Promise((r) => setTimeout(r, interval));
    }
  },

  /**
   * 获取训练结果
   */
  async getTrainingResults(jobId: number): Promise<{
    metrics: TrainMetricsResponse['metrics'];
    summary: TrainSummaryResponse['summary'];
  }> {
    const [metrics, summary] = await Promise.all([
      BackendAPI.getTrainMetrics(jobId).catch(() => ({ job_id: jobId, metrics: {} })),
      BackendAPI.getTrainSummary(jobId).catch(() => ({ job_id: jobId, summary: { num_topics: 0, top_words: [] } })),
    ]);

    return { metrics: metrics.metrics, summary: summary.summary };
  },
};

export default BackendAPI;
