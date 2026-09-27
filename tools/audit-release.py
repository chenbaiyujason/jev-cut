"""Bounded release checks; reports paths and rule names, never matched secrets."""
from pathlib import Path
import re
import subprocess
import sys
import json
from sync_workspace_policy import forbidden_path

ROOT=Path(__file__).resolve().parents[1]
PATTERNS={
 'google-api-key':re.compile(rb'AIza[0-9A-Za-z_-]{30,}'),
 'github-token':re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})'),
 'provider-key':re.compile(rb'(?:sk-[A-Za-z0-9_-]{24,}|AQ\.[A-Za-z0-9_-]{30,})'),
 'private-key':re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
 'nonempty-env-secret':re.compile(rb'(?m)^[ \t]*(?:GEMINI_API_KEY|JEV_API_KEY|WINNOW_API_KEY|OPENAI_API_KEY)[ \t]*=[ \t]*[^\s#\r\n][^\r\n]+$'),
 'private-machine-path':re.compile(rb'(?:[EC]:[/\\](?:Users[/\\]Administrator|ShichenPro[/\\]SCCodex))'),
}
def main():
    names=subprocess.check_output(['git','-C',str(ROOT),'ls-files','--cached','--others','--exclude-standard','-z']).decode().split('\0');issues=[];count=0;size=0
    for name in sorted(set(n for n in names if n)):
        file=ROOT/name
        if not file.exists():continue
        count+=1
        if file.is_symlink():issues.append({'file':name,'rule':'symlink'});continue
        if forbidden_path(name):issues.append({'file':name,'rule':'private-artifact-path'})
        data=file.read_bytes();size+=len(data)
        if len(data)>40_000_000:issues.append({'file':name,'rule':'oversized-file'})
        if b'\x00' not in data[:4096]:
            for rule,pattern in PATTERNS.items():
                if pattern.search(data):issues.append({'file':name,'rule':rule})
    result={'files':count,'bytes':size,'issues':issues};print(json.dumps(result,ensure_ascii=False,indent=2));return 1 if issues else 0
if __name__=='__main__':sys.exit(main())
