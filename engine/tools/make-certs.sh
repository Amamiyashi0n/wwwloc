#!/bin/bash
# 生成自建 WLOC 需要的证书(与 wloc8/generate_apple_wloc_p12.sh 同源, 输出 PEM 供 Node 使用):
#   certs/ca.crt          根证书(PEM) —— 进描述文件, 装到手机后需在"证书信任设置"手动完全信任
#   certs/server.key|.crt 服务端证书(PEM) —— SAN 覆盖三个定位域名, 只在本机代理里用
#   certs/ca.cer          根证书(DER) —— 备用下载件
# 私钥不要外发、不要提交。
#
# 注意: Windows 上常见 mingw64 原生版 openssl, MSYS 会把它收到的 "/C=CN/..." 形如路径的
# 参数做转换, 所以 subject 一律走 -config 的 [dn] 段, 不用 -subj。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$SCRIPT_DIR/../certs"
mkdir -p "$OUT"
cd "$OUT"

CN="selfhost-wloc"
CONF="openssl.cnf"

cat > "$CONF" <<EOF
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = server_req

[ dn ]
C = CN
O = $CN
OU = $CN Testing
CN = gs-loc.apple.com

[ root_ca ]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical, CA:true
keyUsage = critical, digitalSignature, keyCertSign, cRLSign

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

echo "[*] 生成根证书 (10 年)"
openssl genrsa -out ca.key 2048
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -out ca.crt \
  -extensions root_ca -config "$CONF"

echo "[*] 生成服务端证书 (SAN: gs-loc.apple.com / gs-loc-cn.apple.com / gsp-ssl.ls.apple.com)"
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -config "$CONF"
openssl x509 -req -in server.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 -sha256 \
  -extensions server_cert -extfile "$CONF"

openssl x509 -in ca.crt -outform DER -out ca.cer
rm -f server.csr

echo "[+] 完成:"
ls -la . | grep -E "ca\.|server\."
echo ""
echo "注意: ca.key / server.key 只留在本机, 不要提交、不要分发。"
