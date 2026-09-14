"""Model-specific execution contracts read from the existing engine's CLI/API signatures."""
import ast
import math
from functools import lru_cache

MODEL_CLASSES = {'lda': ('lda', 'SklearnLDA'), 'hdp': ('hdp', 'HDP'), 'stm': ('stm', 'STM'),
                 'btm': ('btm', 'BTM'), 'etm': ('etm', 'OriginalETM'), 'ctm': ('ctm', 'CTM'),
                 'dtm': ('dtm', 'DTM'), 'nvdm': ('nvdm', 'NVDM'), 'gsm': ('gsm', 'GSM'),
                 'prodlda': ('prodlda', 'ProdLDA'), 'bertopic': ('bertopic', 'BERTopicModel'), 'theta': ('theta/etm', 'ETM')}
COMMON = {'num_topics', 'vocab_size', 'skip_eval', 'skip_viz', 'language', 'lang'}
NEURAL = {'epochs', 'batch_size', 'learning_rate', 'hidden_dim'}
MODEL_CLI = {
    'lda': {'max_iter'}, 'stm': {'max_iter'}, 'hdp': {'max_topics', 'alpha'}, 'btm': {'n_iter', 'alpha', 'beta'},
    'etm': NEURAL | {'embedding_dim', 'dropout', 'patience'},
    'ctm': NEURAL | {'num_layers', 'inference_type', 'patience'}, 'dtm': NEURAL | {'embedding_dim'},
    'nvdm': NEURAL, 'gsm': NEURAL, 'prodlda': NEURAL,
    'bertopic': {'n_neighbors', 'n_components', 'min_cluster_size', 'min_samples', 'top_n_words', 'random_state'},
    'theta': NEURAL | {'mode', 'model_size', 'kl_start', 'kl_end', 'kl_warmup', 'patience', 'no_early_stopping',
                      'embedding_provider', 'embedding_cloud_provider', 'embedding_model', 'embedding_api_base',
                      'embedding_api_key_env', 'embedding_dimensions'},
}
# These are supplied by the approved job/data, not arbitrary file paths or tensor arguments.
DERIVED = {'self', 'vocab_size', 'num_topics', 'doc_embedding_dim', 'vocab', 'bow_matrix', 'bow', 'bow_data',
           'word_embeddings', 'covariates', 'covariate_names', 'texts', 'embeddings', 'dataset', 'labels',
           'model_class', 'model_name', 'num_classes'}
MANAGED_CLI = {'dataset': 'host dataset binding', 'models': 'plan.modelId', 'model': 'derived preparation kind',
               'gpu': 'plan.device', 'user_id': 'host isolation', 'workspace_dir': 'job workspace', 'output_dir': 'job workspace',
               'output_base_dir': 'job result directory', 'task_name': 'job identity', 'exp_name': 'job identity',
               'data_exp': 'prepared job artifact', 'train_exp': 'job artifact', 'raw_input': 'approved dataset',
               'label_col': 'plan.labelColumn', 'timestamp_column': 'plan.timeColumn', 'time_column': 'plan.timeColumn',
               'covariate_columns': 'plan.covariates', 'timestamp': 'selected result job',
               'check_only': 'runtime_check / training_prepare', 'prepare': 'approved preprocessing stage',
               'skip_train': 'results_read for existing job', 'force': 'fresh isolated job workspace',
               'config': 'config.* structured approved parameters', 'local_rank': 'launcher-owned', 'world_size': 'launcher-owned'}


def literal(node):
    try: return ast.literal_eval(node)
    except (ValueError, TypeError): return ast.unparse(node) if node is not None else None


@lru_cache(maxsize=32)
def source(root, file):
    return ast.parse((root / 'src/models' / file).read_text(encoding='utf-8'))


def cli_parameters(root, file):
    result = {}
    tree = source(root, file)
    constants = {node.targets[0].id: literal(node.value) for node in tree.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute) or node.func.attr != 'add_argument': continue
        flags = [arg.value for arg in node.args if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and arg.value.startswith('--')]
        if not flags: continue
        keywords = {item.arg: item.value for item in node.keywords}
        name = flags[0][2:].replace('-', '_')
        action = literal(keywords.get('action'))
        enum = literal(keywords.get('choices'))
        if isinstance(enum, str): enum = constants.get(enum)
        kind = 'bool' if action in {'store_true', 'store_false'} else literal(keywords.get('type')) or 'str'
        result[name] = {'flag': flags[0], 'type': kind, 'default': literal(keywords.get('default')), 'choices': enum,
                        'action': action, 'line': node.lineno, 'source': file}
    return result


def api_parameters(root, file, class_name, method):
    tree = source(root, file)
    owner = next((node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name), None) if class_name else tree
    fn = next((node for node in owner.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == method), None) if owner else None
    if fn is None: return {}
    args = fn.args.posonlyargs + fn.args.args
    defaults = [None] * (len(args) - len(fn.args.defaults)) + fn.args.defaults
    result = {}
    for arg, default in zip(args, defaults):
        value = literal(default)
        annotation = ast.unparse(arg.annotation) if arg.annotation else ''
        kind = ('bool' if isinstance(value, bool) or annotation == 'bool' else 'int' if isinstance(value, int) or annotation in {'int', 'Optional[int]'}
                else 'float' if isinstance(value, float) or annotation in {'float', 'Optional[float]'} else 'array' if isinstance(value, (tuple, list)) or 'Tuple[' in annotation or annotation == 'tuple' else 'str')
        result[arg.arg] = {'type': kind, 'default': value, 'nullable': default is not None and value is None, 'source': f'{file}:{class_name or ""}.{method}', 'line': arg.lineno}
    return result


def config_parameters(root, class_name='ModelConfig'):
    cls = next(node for node in source(root, 'config.py').body if isinstance(node, ast.ClassDef) and node.name == class_name)
    return {node.target.id: {'type': ast.unparse(node.annotation), 'default': literal(node.value), 'source': 'config.py:' + class_name, 'line': node.lineno}
            for node in cls.body if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)}


def contract(root, model):
    native = cli_parameters(root, 'run_pipeline.py')
    allowed = COMMON | MODEL_CLI[model]
    if model == 'hdp': allowed = allowed - {'num_topics'}
    entries = {key: {**native[key], 'target': 'pipeline'} for key in sorted(allowed)}
    for key, info in cli_parameters(root, 'prepare_data.py').items():
        if key in MANAGED_CLI or key.startswith('embedding_') or key in {'model_size', 'mode', 'language'}: continue
        if model != 'dtm' and key == 'time_slices': continue
        if model == 'theta' and key in {'skip_sbert', 'with_time'}: continue
        if model not in {'theta', 'ctm', 'bertopic', 'dtm'} and key == 'max_length': continue
        entries['prepare.' + key] = {**info, 'target': 'prepare'}
    file, cls = MODEL_CLASSES[model]
    model_file = 'model/' + (file if model == 'theta' else 'baseline/' + file) + '.py'
    for key, info in api_parameters(root, model_file, cls, '__init__').items():
        if key not in DERIVED and key not in allowed and key not in {'word_embedding_dim', 'time_slices', 'embedding_model', 'T'} and not (key == 'train_word_embeddings' and model in {'lda', 'ctm'}) and not (key == 'kl_weight' and model == 'etm'):
            entries['model.' + key] = {**info, 'target': 'constructor'}
    # Dimension/time aliases are already driven by aligned data or exposed unified params.
    for key, info in api_parameters(root, model_file, cls, 'fit').items():
        if key not in DERIVED and key in {'verbose'}: entries['fit.' + key] = {**info, 'target': 'fit'}
    if model != 'theta':
        trainer_file = 'model/baseline_trainer.py'
        method = '_train_neural_topic_model' if model in {'nvdm', 'gsm', 'prodlda'} else 'train_' + model
        for key, info in api_parameters(root, trainer_file, 'BaselineTrainer', method).items():
            if key not in DERIVED and key not in allowed and key != 'early_stopping_patience': entries['trainer.' + key] = {**info, 'target': 'trainer'}
    else:
        for key, info in config_parameters(root).items():
            if key not in DERIVED and key not in allowed and key not in {'kl_warmup_epochs'}: entries['config.' + key] = {**info, 'target': 'theta_config'}
        for key, info in cli_parameters(root, 'config.py').items():
            if key not in allowed and key not in MANAGED_CLI and key in {'dev', 'stage1_epochs', 'stage2_epochs', 'lora_r', 'lora_alpha', 'lora_dropout', 'train_word_embeddings', 'no_train_word_embeddings', 'enable_temporal', 'num_workers', 'no_pin_memory', 'no_persistent_workers'}:
                entries['main.' + key] = {**info, 'target': 'theta_main'}
        entries['pipeline.seed'] = {'type': 'int', 'default': 42, 'target': 'theta_pipeline_config', 'source': 'config.py:PipelineConfig'}
        entries['embedding.normalize'] = {'type': 'bool', 'default': True, 'target': 'embedding_policy', 'source': 'config.py:EmbeddingConfig'}
    if model == 'etm':
        entries['embedding_dim']['note'] = '非300维使用既有训练器的 Word2Vec 入口生成匹配矩阵；预处理阶段仅生成 BOW，避免固定300维准备函数发生维度冲突。'
        for key in ['model.train_embeddings', 'trainer.train_embeddings']:
            entries[key]['note'] = '同一词向量训练开关的两个入口别名；任选一个即可，不能设相反值。false 也冻结随机初始化 rho。随机初始化还需 trainer.use_pretrained_embeddings=false。'
        entries['trainer.use_pretrained_embeddings']['note'] = 'false 才是随机初始化；与冻结开关独立。冻结随机向量：此项=false 加 model.train_embeddings=false 即可。'
        for key, info in api_parameters(root, 'model/baseline/etm.py', None, 'train_word2vec_embeddings').items():
            if key not in DERIVED and key not in {'embedding_dim', 'documents', 'sentences'}: entries['word2vec.' + key] = {**info, 'target': 'word2vec'}
    if model in {'theta', 'ctm', 'bertopic'}:
        entries['embedding.model_path'] = {'type': 'str', 'default': None, 'target': 'local_asset', 'source': 'configured local weights'}
    # Text processing auto-detects language; this existing compatibility spelling is converted for THETA main.
    for key in ['model.learning_method', 'trainer.learning_method']:
        if key in entries: entries[key]['choices'] = ['batch', 'online']
    for key in ['model.model_type', 'trainer.model_type']:
        if key in entries: entries[key]['choices'] = ['LDA', 'prodLDA']
    if 'model_size' in entries: entries['model_size']['choices'] = ['0.6B', '4B', '8B']
    entries['language']['choices'] = ['chinese', 'english']
    return entries


def validate_parameters(root, plan):
    entries = contract(root, plan['modelId'])
    params = plan['params']
    aliases = {}
    for key, value in params.items():
        if '.' in key and key.split('.')[0] in {'model', 'trainer', 'config', 'main'}:
            name = key.split('.', 1)[1]
            if name in aliases and aliases[name] != value: raise ValueError(f'{name} 的多个入口设置冲突，请保留一个明确值')
            aliases[name] = value
    for key, value in params.items():
        if key not in entries: raise ValueError(f'{plan["modelId"]} 不支持参数 {key}；请按 models_inspect 的命名空间及实际调用范围设置')
        info = entries[key]
        if value is None:
            if info.get('nullable') or key == 'min_samples': continue
            raise ValueError(f'{key} 不接受 null')
        kind = info['type']
        if kind == 'bool': valid = isinstance(value, bool)
        elif kind == 'int': valid = isinstance(value, int) and not isinstance(value, bool)
        elif kind == 'float': valid = isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)
        elif kind == 'array': valid = isinstance(value, list) and 1 <= len(value) <= 32 and all(isinstance(item, int) and not isinstance(item, bool) and item > 0 for item in value)
        else: valid = isinstance(value, str) and 0 < len(value) <= 500 and not value.startswith('-')
        if not valid: raise ValueError(f'{key} 必须是有效 {kind} 参数')
        if info.get('choices') is not None and value not in info['choices']: raise ValueError(f'{key} 允许值：{info["choices"]}')
        name = key.split('.')[-1]
        if kind in {'int', 'float'}:
            zero = name in {'random_state', 'seed', 'num_workers', 'kl_start', 'kl_end', 'min_delta', 'weight_decay', 'lora_dropout', 'dropout', 'encoder_dropout', 'val_ratio', 'test_ratio', 'kl_weight', 'evolution_weight', 'contrastive_weight'} or key == 'num_topics' and plan['modelId'] == 'bertopic'
            if name == 'n_jobs' and value == -1: continue
            if value < 0 or value == 0 and not zero: raise ValueError(f'{key} 必须为正数' + ('或零' if zero else ''))
            if ('dropout' in name or name.endswith('_ratio') or name == 'scheduler_factor') and value >= 1: raise ValueError(f'{key} 必须小于 1')
    if params.get('mode', 'zero_shot') == 'supervised' and not plan.get('labelColumn'): raise ValueError('supervised 需要明确 labelColumn')
    if plan.get('device', 'cpu') != 'cpu' and not __import__('re').fullmatch(r'cuda:[0-9]+', plan['device']): raise ValueError('device 必须为 cpu 或 cuda:非负编号')
    if plan['modelId'] == 'etm' and params.get('trainer.use_pretrained_embeddings') is False and any(key.startswith('word2vec.') for key in params): raise ValueError('不使用预训练词向量时不能同时设置 Word2Vec 训练参数')
    if params.get('embedding.normalize') is False and params.get('embedding_provider', 'local') in {'local', 'qwen'}: raise ValueError('本地 Qwen 实现固定归一化，normalize=False 仅适用于云嵌入')
    if params.get('prepare.with_time') and not plan.get('timeColumn'): raise ValueError('with_time 需要 timeColumn')
    if params.get('prepare.bow_only') and plan['modelId'] in {'theta', 'ctm', 'bertopic', 'stm'}: raise ValueError('当前模型需要嵌入或协变量，不能只准备 BOW 后训练')
    if 'main.train_word_embeddings' in params and 'main.no_train_word_embeddings' in params and params['main.train_word_embeddings'] == params['main.no_train_word_embeddings']: raise ValueError('词嵌入训练开关冲突')
    if 'config.word_embedding_dim' in params and (params.get('config.train_word_embeddings') is False or params.get('main.no_train_word_embeddings') is True or params.get('main.train_word_embeddings') is False): raise ValueError('冻结预训练词向量时维度由实际矩阵决定')
    if params.get('main.enable_temporal') and not plan.get('timeColumn'): raise ValueError('时间分析必须指定 timeColumn')
    if 'config.test_ratio' in params:
        train, test = params.get('config.train_ratio', .8), params['config.test_ratio']
        if train + test >= 1: raise ValueError('训练和测试比例之和须小于1，保留验证数据')
        if 'config.val_ratio' in params and abs(train + test + params['config.val_ratio'] - 1) > 1e-8: raise ValueError('显式设置的三份数据比例必须合计为1')
    if params.get('config.train_ratio', .8) + params.get('config.val_ratio', .1) >= 1: raise ValueError('训练与验证比例之和必须小于1，保留测试数据')
    return entries
