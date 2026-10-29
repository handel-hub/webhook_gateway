$cert = Get-Item cert:\CurrentUser\My\88287D4693971C1BDD61CCAB96DD678BDEC4832C
New-Item -ItemType Directory -Force -Path scripts\certs | Out-Null

$pfxBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, "password123")
[System.IO.File]::WriteAllBytes("$PWD\scripts\certs\test-cert.pfx", $pfxBytes)

Write-Host "PFX certificate exported successfully to scripts\certs\test-cert.pfx"
