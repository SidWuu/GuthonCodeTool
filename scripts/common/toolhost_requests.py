"""Read ToolHost control frames while the serial command worker is busy."""
from __future__ import annotations

import json
import queue
import threading

from common.operation_control import RequestControl


class ToolHostRequests:
    def __init__(self, stream, reply, metadata):
        self.stream, self.reply, self.metadata = stream, reply, metadata
        self.jobs = queue.Queue(maxsize=64)
        self.controls = {}
        self.lock = threading.Lock()
        self.reader = threading.Thread(target=self._read, name='guthon-toolhost-input', daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.stream:
                try:
                    request = json.loads(line)
                except ValueError:
                    request = None  # Worker retains the existing error response.
                identifier = request.get('id') if isinstance(request, dict) else None
                if isinstance(request, dict) and request.get('type') == 'cancel':
                    with self.lock:
                        control = self.controls.get(identifier) if isinstance(identifier, str) else None
                    accepted = control.cancel() if control is not None else False
                    self.reply({'id':identifier,'type':'control','operation':'cancel','accepted':accepted})
                    continue
                control = RequestControl(supported=False)
                if isinstance(request, dict):
                    command, args = request.get('command'), request.get('args', [])
                    if isinstance(args, list) and all(isinstance(item, str) for item in args):
                        registry = self.metadata['svnActions'] if command == 'svn' else self.metadata['commands']
                        key = args[0] if command == 'svn' and args else command
                        if isinstance(key, str):
                            control.supported = registry.get(key, {}).get('cancellable', False)
                if isinstance(identifier, str):
                    with self.lock:
                        if identifier in self.controls:
                            self.reply({'id':identifier,'type':'control','operation':'request-rejected','errorCode':'ID_CONFLICT'})
                            continue
                        self.controls[identifier] = control
                try:
                    self.jobs.put_nowait((line, identifier, control))
                except queue.Full:
                    self.finish(identifier, control)
                    self.reply({'id':identifier,'type':'result','ok':False,'error':{'code':'QUEUE_FULL','message':'ToolHost 队列已满，请等待当前操作完成'}})
        except (OSError, UnicodeError):
            self.reply({'id':None,'type':'control','operation':'input-failed','errorCode':'INVALID_REQUEST'})
        finally:
            self.jobs.put(None)

    def finish(self, identifier, control):
        with self.lock:
            if isinstance(identifier, str) and self.controls.get(identifier) is control:
                del self.controls[identifier]

    def __iter__(self):
        while True:
            job = self.jobs.get()
            if job is None:
                self.reader.join(timeout=1)
                return
            yield job
