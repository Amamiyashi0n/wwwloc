#!/bin/bash
# 生成自建 WLOC 需要的证书(输出 PEM, 供 Node 引擎使用):
#   certs/ca.crt          根证书(PEM) —— 进描述文件, 装到手机后需在"证书信任设置"手动完全信任
#   certs/ca.cer          根证书(DER) —— 备用下载件
#   certs/server.key|.crt 服务端证书 —— SAN 覆盖三个 Apple 定位域名, 只在本机引擎里用
# 私钥不要外发、不要提交(engine/certs/ 已 gitignore)。
#
# 同时把「公开部分」同步到 ../public/, 让站点直接分发 CA —— 只有证书, 没有私钥:
#   站点上的 /ca.cer 就是这个文件, 手机不必再从引擎管理页手动传文件。
# 重新生成证书后请把 public/ 的变更一并提交, 否则站点分发的会是与引擎不匹配的旧 CA。
#
# 注意: Windows 上常见 mingw64 原生版 openssl, MSYS 会把它收到的 "/C=CN/..." 形如路径的
# 参数做转换, 因此 subject 一律走 -config 的 [dn] 段, 不用 -subj。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$SCRIPT_DIR/../certs"
PUBLIC_DIR="$SCRIPT_DIR/../../public"
mkdir -p "$OUT" "$PUBLIC_DIR"
cd "$OUT"

echo "[*] 生成根证书 (10 年)"

# 根证书与服务端证书用不同的 subject: 根证书不该叫 gs-loc.apple.com
# (它并不拥有该域名, 而 iOS「证书信任设置」会显示这个名字)。
cat > openssl-root.cnf <<'EOF'
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = root_ca

[ dn ]
C = CN
O = selfhost-wloc
OU = selfhost-wloc Testing
CN = selfhost-wloc Root CA

[ root_ca ]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical, CA:true
keyUsage = critical, digitalSignature, keyCertSign, cRLSign
EOF

cat > openssl.cnf <<'EOF'
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = server_req

[ dn ]
C = CN
O = selfhost-wloc
OU = selfhost-wloc Testing
CN = gs-loc.apple.com

[ server_req ]
subjectAltName = @alt_names

[ server_cert ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[ alt_names ]
DNS.1 = gs-loc.apple.com
DNS.2 = gs-loc-cn.apple.com
DNS.3 = gsp-ssl.ls.apple.com
EOF

openssl genrsa -out ca.key 2048
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -out ca.crt -config openssl-root.cnf
openssl x509 -in ca.crt -outform DER -out ca.cer

echo "[*] 生成服务端证书 (SAN: gs-loc.apple.com / gs-loc-cn.apple.com / gsp-ssl.ls.apple.com)"
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -config openssl.cnf
openssl x509 -req -in server.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 -sha256 \
  -extensions server_cert -extfile openssl.cnf
rm -f server.csr

echo "[*] 同步公开证书到站点目录 (仅证书, 无私钥): $PUBLIC_DIR"
cp ca.cer "$PUBLIC_DIR/ca.cer"
cp ca.crt "$PUBLIC_DIR/ca.crt"

echo ""
echo "[+] 完成:"
ls -la . | grep -E "ca\.|server\."
echo ""
echo "根证书主题: $(openssl x509 -in ca.crt -noout -subject)"
echo "根证书指纹: $(openssl x509 -in ca.crt -noout -fingerprint -sha256 | cut -d= -f2)"
echo ""
echo "下一步:"
echo "  1. 站点分发: 运行 'npm run configure' 后提交 public/ 与生成物, 站点 /ca.cer 即更新"
echo "  2. 引擎启动: npm start"
echo ""
echo "注意: certs/ 下的 ca.key / server.key 只留在本机, 不要提交、不要分发。"
