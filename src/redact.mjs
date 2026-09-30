/**
 * Poetst geheimen uit tekst voordat die de node verlaat.
 *
 * Een testpakket krijgt zijn wachtwoorden en tokens als omgevingsvariabelen.
 * Als een test zo'n waarde toch print (in een foutmelding, een URL, een
 * console.log), komt die hier langs en wordt hij vervangen door •••••• —
 * ook de URL-gecodeerde en base64-varianten.
 */

export class Redactor {
  constructor(secrets = []) {
    const variants = new Set();
    for (const raw of secrets) {
      const secret = String(raw ?? '');
      // Heel korte waarden zouden overal in de tekst matchen.
      if (secret.length < 4) continue;
      variants.add(secret);
      variants.add(encodeURIComponent(secret));
      variants.add(Buffer.from(secret).toString('base64').replace(/=+$/, ''));
      try {
        variants.add(JSON.stringify(secret).slice(1, -1));
      } catch { /* geen string */ }
    }
    // Langste eerst, zodat een deel van een lang geheim niet eerst matcht.
    this.secrets = [...variants].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
    this.pattern = this.secrets.length > 0
      ? new RegExp(this.secrets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
      : null;
  }

  redact(text) {
    if (!this.pattern || !text) return text;
    return String(text).replace(this.pattern, '••••••');
  }
}

/**
 * Knipt een stroom tekst in hele regels. Zo valt een geheim nooit half in het
 * ene stuk en half in het volgende, en wordt het dus altijd herkend.
 */
export class LineSplitter {
  constructor(onText) {
    this.onText = onText;
    this.rest = '';
  }

  push(chunk) {
    this.rest += chunk;
    const cut = Math.max(this.rest.lastIndexOf('\n'), this.rest.lastIndexOf('\r'));
    if (cut === -1) {
      // Een heel lange regel zonder einde niet eindeloos vasthouden.
      if (this.rest.length > 65536) {
        this.onText(this.rest);
        this.rest = '';
      }
      return;
    }
    this.onText(this.rest.slice(0, cut + 1));
    this.rest = this.rest.slice(cut + 1);
  }

  end() {
    if (this.rest) this.onText(this.rest);
    this.rest = '';
  }
}
