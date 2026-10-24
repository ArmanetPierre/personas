/**
 * Lecture d'un secret sur l'entrée standard, sans écho. Terminal : saisie masquée (rien ne s'affiche),
 * Entrée pour valider, Ctrl+C pour annuler. Entrée redirigée (`… | npm run engine:key -- set`) : tout le flux.
 */
export async function readSecret(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!input.isTTY) {
    let data = "";
    for await (const chunk of input) data += chunk.toString();
    return data.replace(/\r?\n$/, "");
  }
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (err?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(new Error("Saisie annulée."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}
