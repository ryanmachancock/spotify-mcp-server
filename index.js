#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { trimTrack, trimArtist, trimAlbum, trimPlaylist, getRedirectPort } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Spotify API configuration
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:8888/callback';
const TOKEN_FILE = join(__dirname, 'spotify_tokens.json');

// Required scopes
const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'user-library-modify',
  'user-top-read',
  'user-read-recently-played',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public'
].join(' ');

class SpotifyMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'spotify-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    this.refreshPromise = null;

    this.loadTokens();
    this.setupHandlers();
  }

  loadTokens() {
    if (existsSync(TOKEN_FILE)) {
      try {
        const tokens = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
        this.accessToken = tokens.access_token;
        this.refreshToken = tokens.refresh_token;
        this.tokenExpiry = new Date(tokens.expires_at);
      } catch (error) {
        console.error('Error loading tokens:', error);
      }
    }
  }

  saveTokens() {
    const tokens = {
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expires_at: this.tokenExpiry.toISOString()
    };
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  }

  jsonResult(data) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(data, null, 2)
        }
      ]
    };
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available. Please re-authenticate.');
    }

    // Dedupe concurrent refreshes: if one is already in flight, ride it instead of starting another.
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const response = await axios.post('https://accounts.spotify.com/api/token',
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: this.refreshToken,
            client_id: SPOTIFY_CLIENT_ID,
            client_secret: SPOTIFY_CLIENT_SECRET
          }),
          {
            timeout: 10000,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );

        this.accessToken = response.data.access_token;
        this.tokenExpiry = new Date(Date.now() + response.data.expires_in * 1000);

        if (response.data.refresh_token) {
          this.refreshToken = response.data.refresh_token;
        }

        this.saveTokens();
      } catch (error) {
        const message = error.response?.data?.error_description || error.response?.data?.error?.message || error.message;
        throw new Error(`Failed to refresh token: ${message}`);
      }
    })();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async ensureValidToken() {
    if (!this.accessToken) {
      throw new Error('No access token. Please authenticate first using the spotify_authenticate tool.');
    }

    // Refresh proactively, 60s ahead of actual expiry, instead of waiting to get a 401.
    if (this.tokenExpiry && new Date() >= new Date(this.tokenExpiry.getTime() - 60000)) {
      await this.refreshAccessToken();
    }
  }

  async makeSpotifyRequest(endpoint, options = {}) {
    await this.ensureValidToken();

    const config = {
      timeout: 10000,
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    };

    const url = `https://api.spotify.com/v1${endpoint}`;

    try {
      const response = await axios(url, config);
      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        await this.refreshAccessToken();
        config.headers['Authorization'] = `Bearer ${this.accessToken}`;
        return this.retryRequest(url, config);
      }

      if (error.response?.status === 429) {
        const retryAfterSeconds = parseInt(error.response.headers['retry-after'] || '1', 10);
        await new Promise(resolve => setTimeout(resolve, retryAfterSeconds * 1000));
        return this.retryRequest(url, config);
      }

      throw new Error(error.response?.data?.error?.message || error.message);
    }
  }

  async retryRequest(url, config) {
    try {
      const response = await axios(url, config);
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error?.message || error.message);
    }
  }

  setupHandlers() {
    this.tools = this.buildTools();

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const tool = this.tools.find(t => t.name === name);

      if (!tool) {
        return this.jsonErrorResult(`Unknown tool: ${name}`);
      }

      try {
        return await tool.handler(args || {});
      } catch (error) {
        return this.jsonErrorResult(error.message);
      }
    });
  }

  jsonErrorResult(message) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${message}`
        }
      ]
    };
  }

  buildTools() {
    return [
      {
        name: 'spotify_authenticate',
        description: 'Authenticate with Spotify to access your personal data',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: () => this.authenticate()
      },
      {
        name: 'get_user_profile',
        description: 'Get your Spotify user profile information',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: () => this.getUserProfile()
      },
      {
        name: 'get_top_tracks',
        description: 'Get your top tracks over different time periods',
        inputSchema: {
          type: 'object',
          properties: {
            time_range: {
              type: 'string',
              enum: ['short_term', 'medium_term', 'long_term'],
              description: 'Time range: short_term (4 weeks), medium_term (6 months), long_term (several years)',
              default: 'medium_term'
            },
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 50,
              default: 20,
              description: 'Number of tracks to return'
            }
          }
        },
        handler: (args) => this.getTopTracks(args.time_range, args.limit)
      },
      {
        name: 'get_top_artists',
        description: 'Get your top artists over different time periods',
        inputSchema: {
          type: 'object',
          properties: {
            time_range: {
              type: 'string',
              enum: ['short_term', 'medium_term', 'long_term'],
              description: 'Time range: short_term (4 weeks), medium_term (6 months), long_term (several years)',
              default: 'medium_term'
            },
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 50,
              default: 20,
              description: 'Number of artists to return'
            }
          }
        },
        handler: (args) => this.getTopArtists(args.time_range, args.limit)
      },
      {
        name: 'get_recently_played',
        description: 'Get your recently played tracks',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 50,
              default: 20,
              description: 'Number of tracks to return'
            }
          }
        },
        handler: (args) => this.getRecentlyPlayed(args.limit)
      },
      {
        name: 'search',
        description: 'Search Spotify for tracks, albums, artists, or playlists',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            types: {
              type: 'array',
              items: { type: 'string', enum: ['track', 'album', 'artist', 'playlist'] },
              description: 'Types of items to search for',
              default: ['track']
            },
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 50,
              default: 20,
              description: 'Number of results to return per type'
            }
          },
          required: ['query']
        },
        handler: (args) => this.search(args.query, args.types, args.limit)
      },
      {
        name: 'get_playlists',
        description: 'Get your playlists',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 50,
              default: 20,
              description: 'Number of playlists to return'
            }
          }
        },
        handler: (args) => this.getPlaylists(args.limit)
      },
      {
        name: 'get_playlist_tracks',
        description: 'Get tracks from a specific playlist',
        inputSchema: {
          type: 'object',
          properties: {
            playlist_id: { type: 'string', description: 'Spotify playlist ID' },
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 100,
              default: 50,
              description: 'Number of tracks to return'
            }
          },
          required: ['playlist_id']
        },
        handler: (args) => this.getPlaylistTracks(args.playlist_id, args.limit)
      },
      {
        name: 'create_playlist',
        description: 'Create a new playlist',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Playlist name' },
            description: { type: 'string', description: 'Playlist description' },
            public: { type: 'boolean', default: false, description: 'Whether the playlist should be public' }
          },
          required: ['name']
        },
        handler: (args) => this.createPlaylist(args.name, args.description, args.public)
      },
      {
        name: 'add_tracks_to_playlist',
        description: 'Add tracks to a playlist',
        inputSchema: {
          type: 'object',
          properties: {
            playlist_id: { type: 'string', description: 'Spotify playlist ID' },
            track_uris: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of Spotify track URIs (spotify:track:...)',
              maxItems: 100
            }
          },
          required: ['playlist_id', 'track_uris']
        },
        handler: (args) => this.addTracksToPlaylist(args.playlist_id, args.track_uris)
      },
      {
        name: 'remove_tracks_from_playlist',
        description: 'Remove tracks from a playlist',
        inputSchema: {
          type: 'object',
          properties: {
            playlist_id: { type: 'string', description: 'Spotify playlist ID' },
            track_uris: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of Spotify track URIs to remove (spotify:track:...)',
              maxItems: 100
            }
          },
          required: ['playlist_id', 'track_uris']
        },
        handler: (args) => this.removeTracksFromPlaylist(args.playlist_id, args.track_uris)
      },
      {
        name: 'reorder_playlist_tracks',
        description: 'Reorder tracks within a playlist',
        inputSchema: {
          type: 'object',
          properties: {
            playlist_id: { type: 'string', description: 'Spotify playlist ID' },
            range_start: { type: 'number', description: 'Position of the first track to move' },
            insert_before: { type: 'number', description: 'Position to insert the moved track(s) before' },
            range_length: { type: 'number', minimum: 1, description: 'Number of tracks to move, defaults to 1' }
          },
          required: ['playlist_id', 'range_start', 'insert_before']
        },
        handler: (args) => this.reorderPlaylistTracks(args.playlist_id, args.range_start, args.insert_before, args.range_length)
      },
      {
        name: 'update_playlist_details',
        description: "Update a playlist's name, description, or visibility",
        inputSchema: {
          type: 'object',
          properties: {
            playlist_id: { type: 'string', description: 'Spotify playlist ID' },
            name: { type: 'string', description: 'New playlist name' },
            description: { type: 'string', description: 'New playlist description' },
            public: { type: 'boolean', description: 'Whether the playlist should be public' }
          },
          required: ['playlist_id']
        },
        handler: (args) => this.updatePlaylistDetails(args.playlist_id, args.name, args.description, args.public)
      },
      {
        name: 'get_liked_songs',
        description: 'Get your saved (liked) songs',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 50,
              default: 20,
              description: 'Number of tracks to return'
            }
          }
        },
        handler: (args) => this.getLikedSongs(args.limit)
      },
      {
        name: 'save_tracks',
        description: 'Save tracks to your liked songs',
        inputSchema: {
          type: 'object',
          properties: {
            track_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of Spotify track IDs',
              maxItems: 50
            }
          },
          required: ['track_ids']
        },
        handler: (args) => this.saveTracks(args.track_ids)
      },
      {
        name: 'remove_saved_tracks',
        description: 'Remove tracks from your liked songs',
        inputSchema: {
          type: 'object',
          properties: {
            track_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of Spotify track IDs',
              maxItems: 50
            }
          },
          required: ['track_ids']
        },
        handler: (args) => this.removeSavedTracks(args.track_ids)
      },
      {
        name: 'get_playback_state',
        description: 'Get current playback state: what is playing, on which device, and progress',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: () => this.getPlaybackState()
      },
      {
        name: 'start_playback',
        description: 'Start or resume playback, optionally of a specific context (album/playlist) or specific tracks',
        inputSchema: {
          type: 'object',
          properties: {
            context_uri: { type: 'string', description: 'Spotify URI of an album, artist, or playlist to play' },
            uris: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of specific track URIs to play'
            },
            device_id: { type: 'string', description: 'Target device ID; defaults to the currently active device' }
          }
        },
        handler: (args) => this.startPlayback(args)
      },
      {
        name: 'pause_playback',
        description: 'Pause playback',
        inputSchema: {
          type: 'object',
          properties: {
            device_id: { type: 'string', description: 'Target device ID; defaults to the currently active device' }
          }
        },
        handler: (args) => this.pausePlayback(args.device_id)
      },
      {
        name: 'skip_to_next',
        description: 'Skip to the next track',
        inputSchema: {
          type: 'object',
          properties: {
            device_id: { type: 'string', description: 'Target device ID; defaults to the currently active device' }
          }
        },
        handler: (args) => this.skipToNext(args.device_id)
      },
      {
        name: 'skip_to_previous',
        description: 'Skip to the previous track',
        inputSchema: {
          type: 'object',
          properties: {
            device_id: { type: 'string', description: 'Target device ID; defaults to the currently active device' }
          }
        },
        handler: (args) => this.skipToPrevious(args.device_id)
      },
      {
        name: 'set_volume',
        description: 'Set playback volume',
        inputSchema: {
          type: 'object',
          properties: {
            volume_percent: { type: 'number', minimum: 0, maximum: 100, description: 'Volume level, 0-100' },
            device_id: { type: 'string', description: 'Target device ID; defaults to the currently active device' }
          },
          required: ['volume_percent']
        },
        handler: (args) => this.setVolume(args.volume_percent, args.device_id)
      },
      {
        name: 'get_devices',
        description: 'List available Spotify Connect devices',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: () => this.getDevices()
      },
      {
        name: 'get_queue',
        description: 'Get the current playback queue',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: () => this.getQueue()
      },
      {
        name: 'add_to_queue',
        description: 'Add a track to the playback queue',
        inputSchema: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: 'Spotify track URI to add to the queue' },
            device_id: { type: 'string', description: 'Target device ID; defaults to the currently active device' }
          },
          required: ['uri']
        },
        handler: (args) => this.addToQueue(args.uri, args.device_id)
      }
    ];
  }

  async authenticate() {
    return new Promise((resolve, reject) => {
      const app = express();
      const port = getRedirectPort(SPOTIFY_REDIRECT_URI);

      app.get('/callback', async (req, res) => {
        const { code, error } = req.query;

        if (error) {
          res.send(`Authentication failed: ${error}`);
          reject(new Error(`Authentication failed: ${error}`));
          return;
        }

        try {
          const response = await axios.post('https://accounts.spotify.com/api/token',
            new URLSearchParams({
              grant_type: 'authorization_code',
              code: code,
              redirect_uri: SPOTIFY_REDIRECT_URI,
              client_id: SPOTIFY_CLIENT_ID,
              client_secret: SPOTIFY_CLIENT_SECRET
            }),
            {
              timeout: 10000,
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            }
          );

          this.accessToken = response.data.access_token;
          this.refreshToken = response.data.refresh_token;
          this.tokenExpiry = new Date(Date.now() + response.data.expires_in * 1000);

          this.saveTokens();

          res.send('Authentication successful! You can close this window.');
          server.close();

          resolve({
            content: [
              {
                type: 'text',
                text: 'Successfully authenticated with Spotify! You can now use all Spotify tools.'
              }
            ]
          });
        } catch (error) {
          const message = error.response?.data?.error_description || error.response?.data?.error?.message || error.message;
          res.send(`Authentication error: ${message}`);
          reject(new Error(message));
        }
      });

      const server = app.listen(port, () => {
        const authUrl = `https://accounts.spotify.com/authorize?` +
          `client_id=${SPOTIFY_CLIENT_ID}&` +
          `response_type=code&` +
          `redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT_URI)}&` +
          `scope=${encodeURIComponent(SCOPES)}`;

        console.log('Opening browser for Spotify authentication...');
        open(authUrl);
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use. Something else may already be running on that port — close it, or set SPOTIFY_REDIRECT_URI to use a different port (and register the new URI with your Spotify app).`));
        } else {
          reject(new Error(`Failed to start authentication server: ${err.message}`));
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('Authentication timeout'));
      }, 300000);
    });
  }

  async getUserProfile() {
    const profile = await this.makeSpotifyRequest('/me');
    return this.jsonResult(profile);
  }

  async getTopTracks(timeRange = 'medium_term', limit = 20) {
    const data = await this.makeSpotifyRequest(`/me/top/tracks?time_range=${timeRange}&limit=${limit}`);
    return this.jsonResult({
      items: (data.items || []).map(trimTrack),
      total: data.total,
      limit: data.limit,
      offset: data.offset,
      next: data.next
    });
  }

  async getTopArtists(timeRange = 'medium_term', limit = 20) {
    const data = await this.makeSpotifyRequest(`/me/top/artists?time_range=${timeRange}&limit=${limit}`);
    return this.jsonResult({
      items: (data.items || []).map(trimArtist),
      total: data.total,
      limit: data.limit,
      offset: data.offset,
      next: data.next
    });
  }

  async getRecentlyPlayed(limit = 20) {
    const data = await this.makeSpotifyRequest(`/me/player/recently-played?limit=${limit}`);
    return this.jsonResult({
      items: (data.items || []).map(item => ({
        played_at: item.played_at,
        track: trimTrack(item.track)
      })),
      next: data.next
    });
  }

  async search(query, types = ['track'], limit = 20) {
    const typeParam = (types && types.length ? types : ['track']).join(',');
    const data = await this.makeSpotifyRequest(`/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(typeParam)}&limit=${limit}`);

    const result = {};
    if (data.tracks) result.tracks = { items: data.tracks.items.map(trimTrack), total: data.tracks.total };
    if (data.artists) result.artists = { items: data.artists.items.map(trimArtist), total: data.artists.total };
    if (data.albums) result.albums = { items: data.albums.items.map(trimAlbum), total: data.albums.total };
    if (data.playlists) result.playlists = { items: data.playlists.items.map(trimPlaylist), total: data.playlists.total };

    return this.jsonResult(result);
  }

  async getPlaylists(limit = 20) {
    const data = await this.makeSpotifyRequest(`/me/playlists?limit=${limit}`);
    return this.jsonResult({
      items: (data.items || []).map(trimPlaylist),
      total: data.total,
      limit: data.limit,
      offset: data.offset,
      next: data.next
    });
  }

  async getPlaylistTracks(playlistId, limit = 50) {
    const data = await this.makeSpotifyRequest(`/playlists/${playlistId}/tracks?limit=${limit}`);
    return this.jsonResult({
      items: (data.items || []).map(item => ({
        added_at: item.added_at,
        track: trimTrack(item.track)
      })),
      total: data.total,
      limit: data.limit,
      offset: data.offset,
      next: data.next
    });
  }

  async createPlaylist(name, description = '', isPublic = false) {
    const profile = await this.makeSpotifyRequest('/me');
    const playlist = await this.makeSpotifyRequest(`/users/${profile.id}/playlists`, {
      method: 'POST',
      data: {
        name,
        description,
        public: isPublic
      }
    });
    return this.jsonResult(trimPlaylist(playlist));
  }

  async addTracksToPlaylist(playlistId, trackUris) {
    const result = await this.makeSpotifyRequest(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      data: {
        uris: trackUris
      }
    });
    return this.jsonResult(result);
  }

  async removeTracksFromPlaylist(playlistId, trackUris) {
    const result = await this.makeSpotifyRequest(`/playlists/${playlistId}/tracks`, {
      method: 'DELETE',
      data: {
        tracks: trackUris.map(uri => ({ uri }))
      }
    });
    return this.jsonResult(result);
  }

  async reorderPlaylistTracks(playlistId, rangeStart, insertBefore, rangeLength) {
    const data = { range_start: rangeStart, insert_before: insertBefore };
    if (rangeLength !== undefined) data.range_length = rangeLength;

    const result = await this.makeSpotifyRequest(`/playlists/${playlistId}/tracks`, {
      method: 'PUT',
      data
    });
    return this.jsonResult(result);
  }

  async updatePlaylistDetails(playlistId, name, description, isPublic) {
    const data = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (isPublic !== undefined) data.public = isPublic;

    await this.makeSpotifyRequest(`/playlists/${playlistId}`, {
      method: 'PUT',
      data
    });
    return this.jsonResult({ success: true });
  }

  async getLikedSongs(limit = 20) {
    const data = await this.makeSpotifyRequest(`/me/tracks?limit=${limit}`);
    return this.jsonResult({
      items: (data.items || []).map(item => ({
        added_at: item.added_at,
        track: trimTrack(item.track)
      })),
      total: data.total,
      limit: data.limit,
      offset: data.offset,
      next: data.next
    });
  }

  async saveTracks(trackIds) {
    await this.makeSpotifyRequest('/me/tracks', {
      method: 'PUT',
      data: { ids: trackIds }
    });
    return this.jsonResult({ success: true });
  }

  async removeSavedTracks(trackIds) {
    await this.makeSpotifyRequest('/me/tracks', {
      method: 'DELETE',
      data: { ids: trackIds }
    });
    return this.jsonResult({ success: true });
  }

  async getPlaybackState() {
    const data = await this.makeSpotifyRequest('/me/player');
    if (!data) {
      return this.jsonResult({ is_playing: false, message: 'No active playback session.' });
    }
    return this.jsonResult({
      is_playing: data.is_playing,
      progress_ms: data.progress_ms,
      device: data.device
        ? {
            id: data.device.id,
            name: data.device.name,
            type: data.device.type,
            volume_percent: data.device.volume_percent
          }
        : null,
      item: trimTrack(data.item)
    });
  }

  async startPlayback({ context_uri, uris, device_id } = {}) {
    const data = {};
    if (context_uri) data.context_uri = context_uri;
    if (uris) data.uris = uris;

    const query = device_id ? `?device_id=${encodeURIComponent(device_id)}` : '';
    await this.makeSpotifyRequest(`/me/player/play${query}`, {
      method: 'PUT',
      data
    });
    return this.jsonResult({ success: true });
  }

  async pausePlayback(deviceId) {
    const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    await this.makeSpotifyRequest(`/me/player/pause${query}`, { method: 'PUT' });
    return this.jsonResult({ success: true });
  }

  async skipToNext(deviceId) {
    const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    await this.makeSpotifyRequest(`/me/player/next${query}`, { method: 'POST' });
    return this.jsonResult({ success: true });
  }

  async skipToPrevious(deviceId) {
    const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    await this.makeSpotifyRequest(`/me/player/previous${query}`, { method: 'POST' });
    return this.jsonResult({ success: true });
  }

  async setVolume(volumePercent, deviceId) {
    let query = `volume_percent=${volumePercent}`;
    if (deviceId) query += `&device_id=${encodeURIComponent(deviceId)}`;
    await this.makeSpotifyRequest(`/me/player/volume?${query}`, { method: 'PUT' });
    return this.jsonResult({ success: true });
  }

  async getDevices() {
    const data = await this.makeSpotifyRequest('/me/player/devices');
    return this.jsonResult(data.devices || []);
  }

  async getQueue() {
    const data = await this.makeSpotifyRequest('/me/player/queue');
    return this.jsonResult({
      currently_playing: trimTrack(data.currently_playing),
      queue: (data.queue || []).map(trimTrack)
    });
  }

  async addToQueue(uri, deviceId) {
    let query = `uri=${encodeURIComponent(uri)}`;
    if (deviceId) query += `&device_id=${encodeURIComponent(deviceId)}`;
    await this.makeSpotifyRequest(`/me/player/queue?${query}`, { method: 'POST' });
    return this.jsonResult({ success: true });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Spotify MCP server running on stdio');
  }
}

// Check for required environment variables
if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error('Error: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables are required');
  console.error('Please set them before running the server');
  process.exit(1);
}

const server = new SpotifyMCPServer();
server.run().catch(console.error);
