from pathlib import PurePosixPath
def forbidden_path(name):
    p=PurePosixPath(name)
    if p.as_posix() in {'apps/editor/src/data/changelog.json','apps/editor/src/data/changelog-types.ts'}:
        return False
    private={'.local','.sync','localdevenv','node_modules','data','artifacts','.mad-workspace','.mad-state','__pycache__'}
    media={'.mp4','.mkv','.mov','.mp3','.m4a','.wav','.srt','.ass','.vtt','.gguf','.onnx','.pth','.pt','.safetensors','.npy','.f32','.torrent','.zip','.log','.pyc'}
    return any(part in private or part.startswith('.venv') for part in p.parts) or p.suffix.lower() in media or p.name.startswith('.env') and p.name!='.env.example'
