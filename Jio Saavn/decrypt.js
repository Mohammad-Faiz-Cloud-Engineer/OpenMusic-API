const CryptoJS = require('crypto-js');

function decryptMediaUrl(encryptedUrl) {
  if (!encryptedUrl || typeof encryptedUrl !== 'string') {
    throw new Error('Invalid encrypted URL');
  }

  // JioSaavn's fixed DES key for encrypted_media_url (public, not a server secret).
  const key = CryptoJS.enc.Utf8.parse('38346591');
  const encrypted = CryptoJS.lib.CipherParams.create({
    ciphertext: CryptoJS.enc.Base64.parse(encryptedUrl),
  });

  const decrypted = CryptoJS.DES.decrypt(encrypted, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });

  const result = decrypted.toString(CryptoJS.enc.Utf8);
  if (!result) {
    throw new Error('DES decryption produced empty result');
  }
  return result.trim();
}

module.exports = { decryptMediaUrl };
