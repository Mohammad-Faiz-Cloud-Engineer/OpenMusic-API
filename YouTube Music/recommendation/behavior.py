from .storage import apply_decay_if_needed, cleanup_tally_data, is_safe_key, load_and_save_tally


def update_transition(previous_song_id, current_song_id):
    previous_song_id = str(previous_song_id or "").strip()
    current_song_id = str(current_song_id or "").strip()
    if not previous_song_id or not current_song_id or previous_song_id == current_song_id:
        return
    if not is_safe_key(previous_song_id) or not is_safe_key(current_song_id):
        return

    def _mutate(data):
        data = apply_decay_if_needed(data)
        transitions = data.setdefault("transitions", {})
        source_targets = transitions.setdefault(previous_song_id, {})
        source_targets[current_song_id] = int(source_targets.get(current_song_id, 0)) + 1

        song_order = data.setdefault("_meta", {}).setdefault("song_order", [])
        if previous_song_id in song_order:
            song_order.remove(previous_song_id)
        song_order.append(previous_song_id)

        return cleanup_tally_data(data)

    # load_and_save_tally performs the read-modify-write atomically under the
    # file lock, preventing a race condition where two simultaneous /play
    # requests could both read stale data and then overwrite each other.
    load_and_save_tally(_mutate)


def get_behavior_recommendations(song_id, limit=5):
    song_id = str(song_id or "").strip()
    if not song_id or not is_safe_key(song_id):
        return []

    # Apply decay and persist in one atomic operation so we don't write a
    # decayed snapshot on every read without also saving it.
    def _decay_and_read(data):
        return apply_decay_if_needed(data)

    data = load_and_save_tally(_decay_and_read)

    target_map = data.get("transitions", {}).get(song_id, {})
    ordered_targets = sorted(target_map.items(), key=lambda item: (-int(item[1]), item[0]))
    return [target_id for target_id, _ in ordered_targets[: max(0, int(limit))]]
