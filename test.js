import assert from 'node:assert';
import { trimTrack, trimArtist, trimAlbum, trimPlaylist, getRedirectPort } from './helpers.js';

// trimTrack strips bulk fields, keeps what matters
const rawTrack = {
  id: 't1',
  uri: 'spotify:track:t1',
  name: 'Test Song',
  artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
  album: { name: 'Test Album' },
  duration_ms: 210000,
  popularity: 55,
  explicit: false,
  available_markets: Array(180).fill('US'),
  external_urls: { spotify: 'https://open.spotify.com/track/t1' }
};
const track = trimTrack(rawTrack);
assert.deepStrictEqual(track, {
  id: 't1',
  uri: 'spotify:track:t1',
  name: 'Test Song',
  artists: ['Artist A', 'Artist B'],
  album: 'Test Album',
  duration_ms: 210000,
  popularity: 55,
  explicit: false
});
assert.strictEqual(track.available_markets, undefined, 'available_markets should be stripped');

// trimArtist
const rawArtist = {
  id: 'a1',
  uri: 'spotify:artist:a1',
  name: 'Test Artist',
  genres: ['pop', 'indie'],
  popularity: 70,
  followers: { total: 12345 },
  images: [{ url: 'x' }]
};
assert.deepStrictEqual(trimArtist(rawArtist), {
  id: 'a1',
  uri: 'spotify:artist:a1',
  name: 'Test Artist',
  genres: ['pop', 'indie'],
  popularity: 70,
  followers: 12345
});

// trimAlbum
const rawAlbum = {
  id: 'al1',
  uri: 'spotify:album:al1',
  name: 'Test Album',
  artists: [{ name: 'Artist A' }],
  release_date: '2020-01-01',
  total_tracks: 12,
  available_markets: Array(180).fill('US')
};
assert.deepStrictEqual(trimAlbum(rawAlbum), {
  id: 'al1',
  uri: 'spotify:album:al1',
  name: 'Test Album',
  artists: ['Artist A'],
  release_date: '2020-01-01',
  total_tracks: 12
});

// trimPlaylist
const rawPlaylist = {
  id: 'p1',
  uri: 'spotify:playlist:p1',
  name: 'Test Playlist',
  description: 'A playlist',
  public: true,
  owner: { display_name: 'Ryan' },
  tracks: { total: 42 },
  images: [{ url: 'x' }]
};
assert.deepStrictEqual(trimPlaylist(rawPlaylist), {
  id: 'p1',
  uri: 'spotify:playlist:p1',
  name: 'Test Playlist',
  description: 'A playlist',
  public: true,
  owner: 'Ryan',
  track_count: 42
});

// null-safety, since Spotify search results can contain null entries
assert.strictEqual(trimTrack(null), null);
assert.strictEqual(trimArtist(undefined), undefined);

// getRedirectPort
assert.strictEqual(getRedirectPort('http://localhost:8080/callback'), 8080);
assert.strictEqual(getRedirectPort('http://localhost:8888/callback'), 8888);
assert.strictEqual(getRedirectPort('http://localhost/callback'), 80, 'should use the http default port when none is specified, so it matches what a browser actually requests');
assert.strictEqual(getRedirectPort('https://localhost/callback'), 443, 'should use the https default port when none is specified');
assert.strictEqual(getRedirectPort('not a valid url', 3000), 3000, 'should use provided fallback only when the URL fails to parse');

console.log('All self-checks passed.');
