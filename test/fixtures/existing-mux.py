"""Real OpenSSH, synthetic protocol peer, no sshd/keys/network outside a private namespace.

Wire constants/FD protocol: openssh-portable/PROTOCOL.mux (OpenBSD rev 1.14).
The synthetic server does not authenticate an endpoint or run a remote command.
"""
import array
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading


def isolated():
    fixture = str(Path(__file__).resolve())
    argv = ['bwrap', '--unshare-net', '--unshare-pid', '--unshare-ipc',
            '--unshare-uts', '--die-with-parent', '--new-session', '--clearenv']
    for mount in ['/usr', '/bin', '/lib', '/lib64']:
        if Path(mount).exists():
            argv += ['--ro-bind', mount, mount]
    argv += ['--dir', '/etc',
             '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
             '--tmpfs', '/tmp', '--tmpfs', '/run', '--proc', '/proc', '--dev', '/dev',
             '--ro-bind', fixture, '/fixture.py', '--chdir', '/tmp',
             '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp/home',
             '--setenv', 'LC_ALL', 'C', '--', '/usr/bin/python3', '/fixture.py',
             '--inside', sys.argv[1]]
    # ssh finds ~/.ssh via getpwuid, not HOME. Give the private namespace its own
    # passwd entry so the ambient-config canary has a meaningful positive control.
    with tempfile.TemporaryDirectory(prefix='nodeterm-mux-fixture-') as scratch:
        passwd = Path(scratch) / 'passwd'
        passwd.write_text(f'synthetic-local:x:{os.getuid()}:{os.getgid()}::/tmp/home:/bin/sh\n')
        argv[argv.index('--dir'):argv.index('--dir')] = ['--ro-bind', str(passwd), '/etc/passwd']
        raise SystemExit(subprocess.run(argv, env={'PATH': '/usr/bin:/bin'}).returncode)


def exact(conn, size):
    result = b''
    while len(result) < size:
        more = conn.recv(size - len(result))
        if not more:
            raise EOFError('mux peer closed')
        result += more
    return result


def packet(conn):
    size = struct.unpack('!I', exact(conn, 4))[0]
    assert size <= 65536
    return exact(conn, size)


def send(conn, *words):
    body = struct.pack('!' + 'I' * len(words), *words)
    conn.sendall(struct.pack('!I', len(body)) + body)


def main():
    args = json.loads(sys.argv[2])
    Path('/tmp/home/.ssh').mkdir(parents=True, mode=0o700)
    # A hostile ambient config must not execute, redirect, or add forwards.
    Path('/tmp/home/.ssh/config').write_text(
        'Host *\n  ProxyCommand touch /tmp/ambient-config-ran\n'
        '  PermitLocalCommand yes\n  LocalCommand touch /tmp/ambient-local-ran\n')
    Path('/tmp/home/.ssh/config').chmod(0o600)
    canary = socket.socket()
    canary.bind(('127.0.0.1', 22222))
    canary.listen()
    canary.settimeout(2)
    with socket.create_connection(('127.0.0.1', 22222), timeout=2):
        accepted, _ = canary.accept()
        accepted.close()
    report = {'privateNamespace': True, 'tcpPositiveControl': 1, 'commands': []}
    errors = []

    def serve(listener, mode):
        try:
            conn, _ = listener.accept()
            with conn:
                conn.settimeout(3)
                if mode == 'closedMux':
                    return
                hello = packet(conn)
                assert struct.unpack('!II', hello) == (1, 4)
                send(conn, 1, 99 if mode == 'incompatibleMux' else 4)
                if mode == 'incompatibleMux':
                    return
                while True:
                    request = packet(conn)
                    kind, reqid = struct.unpack('!II', request[:8])
                    if kind == 0x10000004:
                        send(conn, 0x80000005, reqid, os.getpid())
                    else:
                        assert kind == 0x10000002, hex(kind)
                        offset = 8
                        length = struct.unpack('!I', request[offset:offset + 4])[0]
                        offset += 4 + length + 5 * 4  # reserved, 4 bools, escape
                        length = struct.unpack('!I', request[offset:offset + 4])[0]
                        offset += 4 + length  # terminal type
                        length = struct.unpack('!I', request[offset:offset + 4])[0]
                        command = request[offset + 4:offset + 4 + length].decode()
                        fds = []
                        for _ in range(3):
                            data, ancdata, flags, addr = conn.recvmsg(1, socket.CMSG_SPACE(array.array('i').itemsize))
                            assert data and not flags
                            for level, typ, raw in ancdata:
                                assert level == socket.SOL_SOCKET and typ == socket.SCM_RIGHTS
                                item = array.array('i')
                                item.frombytes(raw)
                                fds.extend(item)
                        assert len(fds) == 3
                        try:
                            if mode == 'lostAfterSessionRequest':
                                return
                            if mode == 'refusedMux':
                                reason = b'synthetic refusal'
                                body = struct.pack('!III', 0x80000003, reqid, len(reason)) + reason
                                conn.sendall(struct.pack('!I', len(body)) + body)
                                return
                            report['commands'].append(command)
                            send(conn, 0x80000006, reqid, 7)
                            os.write(fds[1], b'synthetic-evidence\n')
                            send(conn, 0x80000004, 7, 0)
                        finally:
                            for fd in fds:
                                os.close(fd)
                        return
        except Exception as exc:
            errors.append(repr(exc))
        finally:
            listener.close()

    def run(mode):
        path = Path('/tmp/mux.sock')
        path.unlink(missing_ok=True)
        worker = None
        if mode in ['existingMux', 'closedMux', 'incompatibleMux', 'refusedMux', 'lostAfterSessionRequest']:
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(path))
            listener.listen()
            listener.settimeout(4)
            worker = threading.Thread(target=serve, args=(listener, mode))
            worker.start()
        elif mode == 'replacedMux':
            path.write_text('not a socket')
        result = subprocess.run(['/usr/bin/ssh', *args], capture_output=True, timeout=5)
        if worker:
            worker.join(timeout=5)
            assert not worker.is_alive()
        return {'code': result.returncode, 'output': result.stdout.decode(), 'error': result.stderr.decode()}

    for mode in ['existingMux', 'missingMux', 'closedMux', 'replacedMux', 'incompatibleMux', 'refusedMux', 'lostAfterSessionRequest']:
        report[mode] = run(mode)
    assert not errors, errors
    assert not Path('/tmp/ambient-config-ran').exists()
    assert not Path('/tmp/ambient-local-ran').exists()
    canary.setblocking(False)
    unexpected = 0
    while True:
        try:
            conn, _ = canary.accept()
            unexpected += 1
            conn.close()
        except BlockingIOError:
            break
    report['unexpectedTcpConnections'] = unexpected
    # Removing BOTH protection options must execute our private hostile config.
    ambient = args.copy()
    index = ambient.index('ProxyCommand=/bin/false')
    del ambient[index - 1:index + 1]
    index = ambient.index('-F')
    del ambient[index:index + 2]
    ambient_result = subprocess.run(['/usr/bin/ssh', *ambient], capture_output=True, timeout=3)
    assert Path('/tmp/ambient-config-ran').is_file(), ambient_result.stderr.decode()
    report['ambientConfigPositiveControl'] = 1
    # Test the oracle: removing the failing-proxy guard MUST expose a new TCP connection.
    # This deliberate insecure control stays entirely in this private network namespace.
    insecure = args.copy()
    index = insecure.index('ProxyCommand=/bin/false')
    del insecure[index - 1:index + 1]
    canary.settimeout(3)
    child = subprocess.Popen(['/usr/bin/ssh', *insecure], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        conn, _ = canary.accept()
        conn.close()
        report['missingProxyGuardPositiveControl'] = 1
        child.communicate(timeout=3)
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate()
        canary.close()
    print(json.dumps(report))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--inside':
        main()
    else:
        isolated()
