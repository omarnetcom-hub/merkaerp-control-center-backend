DIAN Connector - README

Resumen
-------
Este directorio contiene un scaffold para integrar facturación electrónica con la DIAN:
- `Connector.js` - Orquesta generación, firma y envío.
- `xmlGenerator.js` - Genera XML de factura (placeholder; no XSD-compliant).
- `signer.js` - Implementación P12-based usando `node-forge` + `xml-crypto` (requiere P12 y contraseña).
- `httpClient.js` - Cliente HTTP con opción SOAP.

Requisitos para completar
-------------------------
1. XSDs y ejemplos de XML de DIAN para adaptar `xmlGenerator.js`.
2. Certificado P12/PFX y contraseña para `signer.js`.
3. Credenciales y endpoints de homologación y producción DIAN.
4. Dependencias npm instaladas en `backend` (`npm install`).

Cómo probar localmente
----------------------
1. Desde la raíz del repo, entra en la carpeta `backend` e instala dependencias:

```bash
cd backend
npm install
```

2. Ejecuta el test stub para verificar la generación XML:

```bash
node test/dian_connector_test.js
```

Pasos para completar la integración
----------------------------------
1. Mapear campos del modelo `Invoice` a los XSD DIAN y actualizar `xmlGenerator.js`.
2. Ejecutar firma con `signer.signXml(p12Path, password)` y validar el XML firmado.
3. Configurar `backend/config/dian.config.json` con `endpoint`, `credentials`, `certPath` y `p12Password`.
4. Implementar manejo de errores y reintentos en `httpClient.postToDian` y persistir logs/respuestas en DB.
5. Ejecutar pruebas contra ambiente de homologación DIAN.

Notas de seguridad
------------------
- Mantén P12 y contraseñas fuera del repositorio. Usa Vault/HSM o variables de entorno cifradas.
- Registra envíos y respuestas para auditoría.

Contacto
-------
Si me proporcionas XSDs y credenciales (homologación), puedo adaptar `xmlGenerator` y completar pruebas integradas.
