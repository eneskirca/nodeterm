/* Synthetic protocol client only: no provider, inference, shell, remote host or real account.
 * Kept as a native executable so kernel peer credentials equal the supervisor's actual child.
 */
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <signal.h>
static int all(int fd, void *data, size_t n, int writing) {
  char *p = data;
  while (n) { ssize_t k = writing ? write(fd,p,n) : read(fd,p,n); if(k<=0)return 0; p+=k;n-=(size_t)k; }
  return 1;
}
static int sendframe(int fd, const char *msg) {
  size_t n=strlen(msg); unsigned char h[8]={129,254,(n>>8)&255,n&255,1,2,3,4}, b[4096];
  if(n>sizeof b)return 0;
  for(size_t i=0;i<n;i++)b[i]=msg[i]^h[4+i%4];
  return all(fd,h,8,1)&&all(fd,b,n,1);
}
static int recvframe(int fd) {
  unsigned char h[2],ext[8],buf[65536]; uint64_t n;
  if(!all(fd,h,2,0))return 0;
  n=h[1]&127;
  if(n==126){if(!all(fd,ext,2,0))return 0;n=((unsigned)ext[0]<<8)|ext[1];}
  if(n==127)return 0;
  if(n>sizeof buf)return 0;
  return all(fd,buf,(size_t)n,0);
}
int main(int argc,char **argv) {
  if(argc!=5||strcmp(argv[1],"--remote")||strncmp(argv[2],"unix://",7)||strcmp(argv[3],"resume"))return 90;
  const char *mode=getenv("NT_SYNTHETIC_MODE");if(!mode)mode="ready";
  if(!strcmp(mode,"orphan"))signal(SIGHUP,SIG_IGN);
  if(!strcmp(mode,"wrong-peer")){pid_t pid=fork();if(pid<0)return 91;if(pid>0){waitpid(pid,0,0);return 0;}}
  int fd=socket(AF_UNIX,SOCK_STREAM,0);struct sockaddr_un sa={.sun_family=AF_UNIX};
  if(strlen(argv[2]+7)>=sizeof sa.sun_path)return 92;
  strcpy(sa.sun_path,argv[2]+7);
  if(connect(fd,(struct sockaddr*)&sa,sizeof sa))return 93;
  char *headers="GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nx-codex-app-server-compression: zstd-stream-v1\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n";
  if(!all(fd,headers,strlen(headers),1))return 94;
  char header[16384];size_t used=0;
  do {if(used>=sizeof header-1||!all(fd,header+used,1,0))return 95;header[++used]=0;}
  while(!strstr(header,"\r\n\r\n"));
  if(!sendframe(fd,"{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"synthetic\",\"version\":\"1\"}}}")||!recvframe(fd))return 96;
  if(!sendframe(fd,"{\"method\":\"initialized\"}"))return 97;
  char request[4096];snprintf(request,sizeof request,"{\"id\":2,\"method\":\"thread/resume\",\"params\":{\"threadId\":\"%s\"}}",argv[4]);
  if(strcmp(mode,"no-request")&&!sendframe(fd,request))return 98;
  puts("SYNTHETIC_FRONTEND_READY");fflush(stdout);
  if(!strcmp(mode,"background"))setpgid(0,0);
  if(!strcmp(mode,"switch")){if(!recvframe(fd))return 99;sendframe(fd,"{\"id\":3,\"method\":\"thread/resume\",\"params\":{\"threadId\":\"foreign\"}}");}
  if(!strcmp(mode,"fork")){if(!recvframe(fd))return 99;sendframe(fd,"{\"id\":3,\"method\":\"thread/fork\",\"params\":{\"threadId\":\"foreign\"}}");}
  while(recvframe(fd)){puts("SYNTHETIC_REPLY_RECEIVED");fflush(stdout);}
  if(!strcmp(mode,"orphan"))for(;;)pause();
  close(fd);return 0;
}
