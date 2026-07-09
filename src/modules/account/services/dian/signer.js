const fs = require('fs');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('xmldom');

function loadP12(p12Path, password) {
  const raw = fs.readFileSync(p12Path, { encoding: 'binary' });
  const p12Asn1 = forge.asn1.fromDer(raw);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
  return p12;
}

function extractKeyAndCertFromP12(p12, password) {
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = bags[forge.pki.oids.certBag];
  const certs = certBag.map(b => forge.pki.certificateToPem(b.cert));

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  const privateKeyPem = keyBags.length ? forge.pki.privateKeyToPem(keyBags[0].key) : null;

  return { certs, privateKeyPem };
}

exports.signXml = function(xml, p12Path, p12Password) {
  if (!p12Path || !p12Password) {
    throw new Error('P12 path and password are required to sign XML');
  }

  const p12 = loadP12(p12Path, p12Password);
  const { certs, privateKeyPem } = extractKeyAndCertFromP12(p12, p12Password);
  if (!privateKeyPem) throw new Error('No private key found inside P12');

  // Use xml-crypto to sign the XML. This is a minimal example and may need
  // adaptation to DIAN's required transforms and signature placement.
  const sig = new SignedXml();
  sig.signingKey = privateKeyPem;

  // Add certificate as KeyInfo
  const certPem = certs[0] || '';
  sig.keyInfoProvider = {
    getKeyInfo: () => `<X509Data><X509Certificate>${certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\n/g, '')}</X509Certificate></X509Data>`,
    getKey: () => privateKeyPem
  };

  // Reference the root element
  sig.addReference("/*", ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'], 'http://www.w3.org/2001/04/xmlenc#sha256');

  const doc = new DOMParser().parseFromString(xml);
  sig.computeSignature(xml);
  const signed = sig.getSignedXml();
  return signed;
};
