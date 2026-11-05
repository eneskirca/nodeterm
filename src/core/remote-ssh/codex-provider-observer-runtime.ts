/** Linux-only remote helper, transported as app-owned source, never installed/run at import.
 * Python's SO_PEERCRED supplies kernel peer identity missing from Node's public socket API.
 * No credentials, transcript persistence, provider lifecycle commands or network listeners.
 */
export const CODEX_PROVIDER_OBSERVER_RUNTIME = String.raw`
import hashlib, json, os, re, signal, socket, stat, struct, subprocess, sys, threading

LIMIT = 1024 * 1024
SAFE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
BOOT = open('/proc/sys/kernel/random/boot_id').read().strip()

def fail():
    raise RuntimeError('provider observation unavailable')

def strict_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result: fail()
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: fail())

def birth(pid):
    raw = open('/proc/%d/stat' % pid).read()
    end = raw.rfind(')')
    if end < 0: fail()
    fields = raw[end+2:].split()
    uid = os.stat('/proc/%d' % pid).st_uid
    exe = os.stat('/proc/%d/exe' % pid)
    if fields[0] in ('Z', 'X') or uid != os.getuid(): fail()
    return dict(bootId=BOOT, uid=uid, pid=pid, startTicks=fields[19],
                pgrp=int(fields[2]), tty=int(fields[4]), tpgid=int(fields[5]),
                exeDev=str(exe.st_dev), exeIno=str(exe.st_ino))

def same_birth(a, b):
    return all(a[k] == b[k] for k in ('bootId','uid','pid','startTicks','exeDev','exeIno'))

def digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''): h.update(chunk)
    return h.hexdigest()

def private_dir(directory):
    s = os.lstat(directory)
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077: fail()
    if os.path.realpath(directory) != directory: fail()

def socket_identity(file):
    s = os.lstat(file)
    if not stat.S_ISSOCK(s.st_mode) or s.st_uid != os.getuid(): fail()
    return dict(dev=str(s.st_dev), ino=str(s.st_ino), ctimeNs=str(s.st_ctime_ns))

def peer(sock):
    pid, uid, gid = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if uid != os.getuid(): fail()
    return birth(pid)

def effective_home(pid):
    # Read selected metadata in memory; never return/log environ or credential values.
    data = open('/proc/%d/environ' % pid, 'rb').read(LIMIT + 1)
    if len(data) > LIMIT: fail()
    env = {}
    for kv in data.split(b'\0'):
        k, _, v = kv.partition(b'=')
        if k in (b'CODEX_HOME', b'HOME'): env[k] = os.fsdecode(v)
    home = env.get(b'CODEX_HOME') or os.path.join(env.get(b'HOME', ''), '.codex')
    if not os.path.isabs(home): fail()
    return os.path.realpath(home)

def upstream(plan):
    before = socket_identity(plan['upstreamSocket'])
    sock = socket.socket(socket.AF_UNIX)
    sock.settimeout(2)
    try:
        sock.connect(plan['upstreamSocket'])
        who = peer(sock)
        if before != socket_identity(plan['upstreamSocket']): fail()
        if effective_home(who['pid']) != plan['codeHome']: fail()
        if digest('/proc/%d/exe' % who['pid']) != plan['daemonSha256']: fail()
        if not same_birth(who, birth(who['pid'])): fail()
        return sock, dict(socket=before, process=who)
    except BaseException:
        sock.close()
        raise

def bounded_json(stream):
    data = stream.read(LIMIT + 1)
    if len(data) > LIMIT: fail()
    return strict_json(data)

def load(directory, expected=None):
    private_dir(directory)
    data = globals().get('_SEALED_PLAN_BYTES')
    if data is None:
        with open(os.path.join(directory, 'plan'), 'rb') as f: data = f.read(LIMIT + 1)
    if len(data) > LIMIT or expected is not None and hashlib.sha256(data).hexdigest() != expected: fail()
    return strict_json(data)

def prepare():
    plan = bounded_json(sys.stdin.buffer)
    for key in ('launchId','nodeId','projectId','threadId','accountId'):
        if not isinstance(plan.get(key), str) or not SAFE.fullmatch(plan[key]): fail()
    for key in ('root','codeHome','cwd','providerExecutable','upstreamSocket'):
        p = plan.get(key)
        if not isinstance(p, str) or not os.path.isabs(p) or '\0' in p or '\n' in p: fail()
    private_dir(plan['root'])
    if plan['codeHome'] != os.path.realpath(plan['codeHome']) or plan['cwd'] != os.path.realpath(plan['cwd']): fail()
    if not re.fullmatch('[a-f0-9]{64}', plan.get('providerSha256','')): fail()
    if not re.fullmatch('[a-f0-9]{64}', plan.get('daemonSha256','')): fail()
    if digest(plan['providerExecutable']) != plan['providerSha256']: fail()
    if not isinstance(plan.get('frontendArgs'), list) or len(plan['frontendArgs']) > 64: fail()
    if any(not isinstance(x, str) or '\0' in x or len(x) > 8192 for x in plan['frontendArgs']): fail()
    # No caller can redirect the attested frontend to another transport/thread/account.
    if plan['frontendArgs']: fail()
    sock, evidence = upstream(plan)
    sock.close()
    plan['daemon'] = evidence
    directory = os.path.join(plan['root'], plan['launchId'])
    if len(os.fsencode(os.path.join(directory, 'p'))) >= 104: fail()
    with os.scandir(plan['root']) as entries:
        for i, _ in enumerate(entries):
            if i >= 255: fail()  # bounded preparation artifacts, no automatic deletion/rebinding
    os.mkdir(directory, 0o700)  # exclusive: no replay or reuse of an existing launch intent
    source = plan.pop('runtimeSource')
    if not isinstance(source, str) or len(source) > 65536: fail()
    with open(os.path.join(directory, 'observer.py'), 'x', encoding='utf-8') as f:
        os.chmod(f.name, 0o400)
        f.write(source)
    with open(os.path.join(directory, 'plan'), 'x', encoding='utf-8') as f:
        os.chmod(f.name, 0o600)
        json.dump(plan, f, separators=(',',':'))
    print(json.dumps(dict(launchId=plan['launchId'], directory=directory,
                          planSha256=digest(os.path.join(directory,'plan')),
                          runtimeSha256=digest(os.path.join(directory,'observer.py')))))

class Frames:
    def __init__(self, masked, accept, refuse, closed=None):
        self.masked, self.accept, self.refuse, self.closed = masked, accept, refuse, closed or refuse
        self.buf, self.message, self.fragment, self.disabled = bytearray(), bytearray(), False, False
    def feed(self, data):
        if self.disabled: return
        self.buf.extend(data)
        try:
            while len(self.buf) >= 2:
                a, b = self.buf[:2]
                fin, op, mask = bool(a & 128), a & 15, bool(b & 128)
                if a & 112 or mask != self.masked: fail()
                n, off = b & 127, 2
                if n == 126:
                    if len(self.buf) < 4: return
                    n, off = struct.unpack('!H', self.buf[2:4])[0], 4
                elif n == 127:
                    if len(self.buf) < 10: return
                    n, off = struct.unpack('!Q', self.buf[2:10])[0], 10
                if n > LIMIT or len(self.message) + n > LIMIT: fail()
                if mask: off += 4
                if len(self.buf) < off + n: return
                payload = bytes(self.buf[off:off+n])
                if mask:
                    key = self.buf[off-4:off]
                    payload = bytes(v ^ key[i % 4] for i, v in enumerate(payload))
                del self.buf[:off+n]
                if op >= 8:
                    if not fin or n > 125 or op not in (8,9,10): fail()
                    if op == 8: self.closed()
                    continue
                if op == 1 and not self.fragment: self.message = bytearray(payload)
                elif op == 0 and self.fragment: self.message.extend(payload)
                else: fail()
                self.fragment = not fin
                if fin:
                    self.accept(strict_json(self.message.decode('utf-8')))
                    self.message.clear()
        except (ValueError, UnicodeError, RuntimeError, KeyError, TypeError, RecursionError):
            self.disabled = True
            self.buf.clear(); self.message.clear()
            self.refuse()

def rpc_id(value):
    if type(value) not in (int, str) or len(str(value)) > 128: fail()
    return (type(value).__name__, value)

class Observation:
    def __init__(self, thread, cwd, current, revoke=lambda: None):
        self.thread, self.cwd, self.current, self.revoke, self.pending = thread, cwd, current, revoke, {}
        self.observed, self.held, self.init, self.initialized = False, False, None, False
    def refuse(self):
        self.held, self.observed = True, False
        self.revoke()
    def disconnect(self):
        if self.observed or self.pending: self.revoke()
        self.held, self.observed = True, False
    def request(self, msg):
        if not isinstance(msg, dict): return self.refuse()
        method = msg.get('method')
        if method == 'turn/start':
            params = msg.get('params')
            if not isinstance(params, dict) or params.get('threadId') != self.thread or params.get('cwd', self.cwd) != self.cwd:
                return self.refuse()
        if method == 'initialize':
            if self.init is not None: return self.refuse()
            self.init = rpc_id(msg.get('id'))
            return
        if method == 'initialized':
            if self.init != 'confirmed': return self.refuse()
            self.initialized = True
            return
        if method in ('thread/start','thread/fork'): return self.refuse()
        if method != 'thread/resume': return
        if self.held: return
        if not self.initialized: return self.refuse()
        params = msg.get('params')
        if not isinstance(params, dict) or params.get('threadId') != self.thread: return self.refuse()
        ident = rpc_id(msg.get('id'))
        if ident in self.pending or len(self.pending) >= 8: return self.refuse()
        self.pending[ident] = True
        self.observed = False
    def response(self, msg):
        if not isinstance(msg, dict): return self.refuse()
        if msg.get('method') in ('account/updated','account/login/completed'): return self.refuse()
        if 'id' not in msg: return
        ident = rpc_id(msg['id'])
        if ident == self.init:
            if 'error' in msg or not isinstance(msg.get('result'), dict): return self.refuse()
            self.init = 'confirmed'
            return
        if ident not in self.pending: return
        del self.pending[ident]
        result = msg.get('result')
        thread = result.get('thread') if isinstance(result, dict) else None
        if 'error' in msg or 'method' in msg or not isinstance(thread, dict) or thread.get('id') != self.thread or thread.get('cwd') != self.cwd or not self.current():
            return self.refuse()
        if not self.held: self.observed = True

def header(sock):
    data = bytearray()
    while b'\r\n\r\n' not in data:
        chunk = sock.recv(4096)
        if not chunk or len(data) + len(chunk) > 16384: fail()
        data.extend(chunk)
    value, tail = data.split(b'\r\n\r\n', 1)
    return value, bytes(tail)

def run(directory):
    plan = load(directory)
    # One launch generation, even if someone retries its old command after the session ended.
    with open(os.path.join(directory,'run.lock'),'x') as f: os.chmod(f.name,0o600)
    if digest(plan['providerExecutable']) != plan['providerSha256']: fail()
    lock, observations, child, frontend, revoked = threading.RLock(), [], None, None, [False]
    supervisor = birth(os.getpid())
    def valid():
        try:
            return frontend is not None and child is not None and child.poll() is None and same_birth(frontend, birth(child.pid)) and \
                os.path.realpath('/proc/%d/cwd' % child.pid) == plan['cwd'] and \
                same_birth(supervisor, birth(os.getpid())) and socket_identity(plan['upstreamSocket']) == plan['daemon']['socket'] and \
                same_birth(plan['daemon']['process'], birth(plan['daemon']['process']['pid'])) and \
                effective_home(plan['daemon']['process']['pid']) == plan['codeHome']
        except (OSError, ValueError, RuntimeError): return False
    def listener(name):
        s = socket.socket(socket.AF_UNIX)
        s.bind(os.path.join(directory, name)); os.chmod(os.path.join(directory, name), 0o600); s.listen(4)
        return s
    proxy, control = listener('p'), listener('c')
    connections = threading.BoundedSemaphore(8)
    def serve_control():
        while True:
            conn, _ = control.accept()
            with conn:
                try:
                    conn.settimeout(2)
                    peer(conn)
                    with lock:
                        ok = not revoked[0] and valid() and any(o.observed and not o.held for o in observations)
                        if ok:
                            f = birth(child.pid)
                            ok = f['tty'] != 0 and f['pgrp'] == f['tpgid']
                        result = dict(schemaVersion=1, launchId=plan['launchId'], nodeId=plan['nodeId'], projectId=plan['projectId'],
                            threadId=plan['threadId'], accountId=plan['accountId'], state='observed' if ok else 'held',
                            supervisor=supervisor, frontend=f if ok else frontend, daemon=plan['daemon'], codeHome=plan['codeHome'], cwd=plan['cwd'])
                    conn.sendall(json.dumps(result, separators=(',',':')).encode())
                except (OSError, ValueError, RuntimeError): pass
    def connection(down):
        observation = None
        up = None
        try:
            down.settimeout(2)
            who = peer(down)
            # Child exists before it can connect, but the worker thread may win assignment.
            ready.wait(2)
            if not valid() or not same_birth(who, frontend): fail()
            up, evidence = upstream(plan)
            if evidence != plan['daemon']: fail()
            h, extra = header(down)
            lines = h.split(b'\r\n')
            if lines[0] != b'GET /rpc HTTP/1.1': fail()
            # Do not negotiate compression: bounded observers inspect the actual JSON messages.
            compression = (b'sec-websocket-extensions:', b'x-codex-app-server-compression:')
            lines = [x for x in lines if not x.lower().startswith(compression)]
            up.sendall(b'\r\n'.join(lines) + b'\r\n\r\n')
            answer, initial = header(up)
            if not answer.startswith(b'HTTP/1.1 101 '): fail()
            if any(x.lower().startswith(compression) for x in answer.split(b'\r\n')): fail()
            down.sendall(answer + b'\r\n\r\n')
            observation = Observation(plan['threadId'], plan['cwd'], valid, lambda: revoked.__setitem__(0, True))
            with lock:
                if len(observations) >= 16: fail()
                observations.append(observation)
            def pump(src, dst, masked, accept, initial):
                frames = Frames(masked, accept, observation.refuse, observation.disconnect)
                try:
                    while True:
                        data = initial or src.recv(65536)
                        initial = b''
                        if not data: break
                        with lock: frames.feed(data)
                        dst.sendall(data)
                except OSError: pass
                finally:
                    with lock: observation.disconnect()
                    try: dst.shutdown(socket.SHUT_WR)
                    except OSError: pass
            down.settimeout(None); up.settimeout(None)
            threading.Thread(target=pump, args=(down,up,True,observation.request,extra), daemon=True).start()
            pump(up,down,False,observation.response,initial)
        except (OSError, RuntimeError, ValueError): pass
        finally:
            if observation:
                with lock: observation.disconnect()
            down.close()
            if up: up.close()
            connections.release()
    def serve_proxy():
        while True:
            conn, _ = proxy.accept()
            if not connections.acquire(blocking=False):
                conn.close()
                continue
            threading.Thread(target=connection,args=(conn,),daemon=True).start()
    ready = threading.Event()
    threading.Thread(target=serve_control,daemon=True).start()
    threading.Thread(target=serve_proxy,daemon=True).start()
    env = os.environ.copy()
    env['CODEX_HOME'] = plan['codeHome']
    env['NODETERM_NODE_ID'] = plan['nodeId']
    env['NODETERM_AGENT_ID'] = 'codex'
    env['NODETERM_CODEX_ACCOUNT_ID'] = '' if plan['accountId'] == 'system' else plan['accountId']
    # No shell, no fallback, no relaunch. Exact argv and actual child PID are owned here.
    child = subprocess.Popen([plan['providerExecutable'], '--remote', 'unix://' + os.path.join(directory,'p'),
                              'resume', plan['threadId']], cwd=plan['cwd'], env=env)
    frontend = birth(child.pid)
    if digest('/proc/%d/exe' % child.pid) != plan['providerSha256']: fail()
    with open(os.path.join(directory,'birth'),'x',encoding='utf-8') as f:
        os.chmod(f.name,0o600)
        data=globals().get('_SEALED_PLAN_BYTES')
        if data is None:
            with open(os.path.join(directory,'plan'),'rb') as source:data=source.read(LIMIT+1)
        json.dump(dict(launchId=plan['launchId'],planSha256=hashlib.sha256(data).hexdigest(),supervisor=supervisor,frontend=frontend),f,separators=(',',':'))
        f.flush();os.fsync(f.fileno())
    ready.set()
    signal.signal(signal.SIGINT, lambda *_: None)  # TUI shares the foreground group and receives it.
    code = child.wait()
    with lock:
        for o in observations: o.refuse()
    return code if code >= 0 else 128 - code

def read(directory):
    seals = bounded_json(sys.stdin.buffer)
    if digest(os.path.join(directory,'observer.py')) != seals['runtimeSha256']: fail()
    plan = load(directory, seals['planSha256'])
    sock = socket.socket(socket.AF_UNIX)
    sock.settimeout(2)
    try:
        sock.connect(os.path.join(directory,'c'))
        supervisor = peer(sock)
        data = bytearray()
        while True:
            chunk = sock.recv(65536)
            if not chunk: break
            data.extend(chunk)
            if len(data) > 65536: fail()
        result = strict_json(data)
        if not same_birth(supervisor, result['supervisor']) or not same_birth(supervisor,birth(supervisor['pid'])): fail()
        if any(result[k] != plan[k] for k in ('launchId','nodeId','projectId','threadId','accountId','codeHome','cwd')): fail()
        if result['daemon'] != plan['daemon']: fail()
        if result['state'] == 'observed':
            f = birth(result['frontend']['pid'])
            if not same_birth(f,result['frontend']) or not f['tty'] or f['pgrp'] != f['tpgid']: fail()
            if socket_identity(plan['upstreamSocket']) != plan['daemon']['socket']: fail()
            if not same_birth(plan['daemon']['process'],birth(plan['daemon']['process']['pid'])): fail()
        print(json.dumps(result,separators=(',',':')))
    finally: sock.close()

def gone(directory):
    seals=bounded_json(sys.stdin.buffer)
    if digest(os.path.join(directory,'observer.py'))!=seals['runtimeSha256']:fail()
    plan=load(directory,seals['planSha256'])
    file=os.path.join(directory,'birth')
    if not os.path.lexists(file):
        if not seals.get('knownBirths'):fail()
        originals=seals['knownBirths']
    else:
        with os.fdopen(os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
            s=os.fstat(f.fileno())
            if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077:fail()
            receipt=bounded_json(f)
        if receipt['launchId']!=plan['launchId'] or receipt['planSha256']!=seals['planSha256']:fail()
        originals=[receipt['supervisor'],receipt['frontend']]
        if seals.get('knownBirths') and any(not same_birth(a,b) for a,b in zip(originals,seals['knownBirths'])):fail()
    if len(originals)!=2:fail()
    for original in originals:
        if original['bootId']!=BOOT:continue
        try:
            raw=open('/proc/%d/stat'%original['pid']).read();end=raw.rfind(')');fields=raw[end+2:].split()
            if end<0:fail()
            # An exec or UID change does not mean that this original OS process ended.
            if fields[19]==original['startTicks'] and fields[0] not in ('Z','X'):fail()
        except FileNotFoundError:continue
    print('{"gone":true}')

if __name__ == '__main__':
    try:
        if sys.argv[1] == 'prepare': prepare()
        elif sys.argv[1] == 'run': sys.exit(run(sys.argv[2]))
        elif sys.argv[1] == 'read': read(sys.argv[2])
        elif sys.argv[1] == 'gone': gone(sys.argv[2])
        else: fail()
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, IndexError, RecursionError):
        # Never print exception text: it can include paths, request data or provider output.
        print('provider observation unavailable', file=sys.stderr)
        sys.exit(1)
`
