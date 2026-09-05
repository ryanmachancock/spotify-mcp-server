export function trimTrack(track) {
  if (!track) return track;
  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: (track.artists || []).map(a => a.name),
    album: track.album?.name,
    duration_ms: track.duration_ms,
    popularity: track.popularity,
    explicit: track.explicit
  };
}

export function trimArtist(artist) {
  if (!artist) return artist;
  return {
    id: artist.id,
    uri: artist.uri,
    name: artist.name,
    genres: artist.genres,
    popularity: artist.popularity,
    followers: artist.followers?.total
  };
}

export function trimAlbum(album) {
  if (!album) return album;
  return {
    id: album.id,
    uri: album.uri,
    name: album.name,
    artists: (album.artists || []).map(a => a.name),
    release_date: album.release_date,
    total_tracks: album.total_tracks
  };
}

export function trimPlaylist(playlist) {
  if (!playlist) return playlist;
  return {
    id: playlist.id,
    uri: playlist.uri,
    name: playlist.name,
    description: playlist.description,
    public: playlist.public,
    owner: playlist.owner?.display_name,
    track_count: playlist.tracks?.total
  };
}

export function getRedirectPort(redirectUri, fallback = 8888) {
  try {
    const url = new URL(redirectUri);
    if (url.port) return parseInt(url.port, 10);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return fallback;
  }
}
