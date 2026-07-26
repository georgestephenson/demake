/**
 * The tournament scoreboard, which doubles as a strategy picker.
 *
 * Exactly what the image demaker's does (doc 07 §UX 3), and shared by both audio
 * sections because both run the same shape of tournament: a curated portfolio,
 * one judge, the winner emitted and every candidate's score reported. Clicking a
 * row pins that candidate, which is `--strategy <name>` on the command line.
 */

interface Candidate {
  id: string;
  summary: string;
  aggregate: number;
  metrics: readonly { id: string; score: number }[];
  disqualified?: { reason: string };
}

interface Props {
  winner: string;
  candidates: readonly Candidate[];
  /** The pinned candidate, or the value that means "run the tournament". */
  pinned: string;
  autoValue: string;
  onPick: (strategy: string) => void;
}

export function AudioScoreboard({ winner, candidates, pinned, autoValue, onPick }: Props) {
  return (
    <details class="scoreboard" open>
      <summary>
        Tournament — <strong>{winner}</strong> won
      </summary>
      <table data-testid="audio-scoreboard">
        <thead>
          <tr>
            <th scope="col">Strategy</th>
            <th scope="col">Score</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => (
            <tr key={candidate.id} class={candidate.id === winner ? "winner" : undefined}>
              <td title={candidate.summary}>{candidate.id}</td>
              <td>
                {candidate.disqualified ? (
                  <span title={candidate.disqualified.reason}>disqualified</span>
                ) : (
                  <span
                    title={candidate.metrics.map((m) => `${m.id} ${m.score.toFixed(2)}`).join("\n")}
                  >
                    {candidate.aggregate.toFixed(3)}
                  </span>
                )}
              </td>
              <td>
                <button
                  type="button"
                  class="link"
                  onClick={() => onPick(candidate.id === pinned ? autoValue : candidate.id)}
                >
                  {candidate.id === pinned ? "unpin" : "pin"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
