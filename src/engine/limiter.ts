/** Limiteur de concurrence FIFO : au plus `max` tâches actives à la fois. */
export interface Limiter {
  readonly max: number;
  readonly active: number;
  readonly pending: number;
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`Concurrence invalide : ${max} (entier >= 1 attendu)`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  return {
    max,
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          active++;
          let p: Promise<T>;
          try {
            p = task();
          } catch (err) {
            p = Promise.reject(err);
          }
          p.then(resolve, reject).finally(release);
        };
        if (active < max) start();
        else queue.push(start);
      });
    },
  };
}
