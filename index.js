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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Spotify API configuration
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = 'http://localhost:8888/callback';
const TOKEN_FILE = join(__dirname, 'spotify_tokens.json');

// Required scopes for comprehensive access
const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'user-library-modify',
  'user-read-playback-position',
  'user-top-read',
  'user-read-recently-played',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-follow-read',
  'user-follow-modify'
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

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available. Please re-authenticate.');
    }

    try {
      const response = await axios.post('https://accounts.spotify.com/api/token', 
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          client_id: SPOTIFY_CLIENT_ID,
          client_secret: SPOTIFY_CLIENT_SECRET
        }),
        {
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
      throw new Error(`Failed to refresh token: ${error.message}`);
    }
  }

  async ensureValidToken() {
    if (!this.accessToken) {
      throw new Error('No access token. Please authenticate first using the spotify_authenticate tool.');
    }

    if (this.tokenExpiry && new Date() >= this.tokenExpiry) {
      await this.refreshAccessToken();
    }
  }

  async makeSpotifyRequest(endpoint, options = {}) {
    await this.ensureValidToken();
    
    const config = {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    };

    try {
      const response = await axios(`https://api.spotify.com/v1${endpoint}`, config);
      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        await this.refreshAccessToken();
        config.headers['Authorization'] = `Bearer ${this.accessToken}`;
        const retryResponse = await axios(`https://api.spotify.com/v1${endpoint}`, config);
        return retryResponse.data;
      }
      throw error;
    }
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'spotify_authenticate',
            description: 'Authenticate with Spotify to access your personal data',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'get_user_profile',
            description: 'Get your Spotify user profile information',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
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
            }
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
            }
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
            }
          },
          {
            name: 'search_tracks',
            description: 'Search for tracks on Spotify',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query for tracks'
                },
                limit: {
                  type: 'number',
                  minimum: 1,
                  maximum: 50,
                  default: 20,
                  description: 'Number of results to return'
                }
              },
              required: ['query']
            }
          },
          {
            name: 'get_track_features',
            description: 'Get audio features for tracks (danceability, energy, valence, etc.)',
            inputSchema: {
              type: 'object',
              properties: {
                track_ids: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of Spotify track IDs',
                  maxItems: 100
                }
              },
              required: ['track_ids']
            }
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
            }
          },
          {
            name: 'get_playlist_tracks',
            description: 'Get tracks from a specific playlist',
            inputSchema: {
              type: 'object',
              properties: {
                playlist_id: {
                  type: 'string',
                  description: 'Spotify playlist ID'
                },
                limit: {
                  type: 'number',
                  minimum: 1,
                  maximum: 100,
                  default: 50,
                  description: 'Number of tracks to return'
                }
              },
              required: ['playlist_id']
            }
          },
          {
            name: 'create_playlist',
            description: 'Create a new playlist',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Playlist name'
                },
                description: {
                  type: 'string',
                  description: 'Playlist description'
                },
                public: {
                  type: 'boolean',
                  default: false,
                  description: 'Whether the playlist should be public'
                }
              },
              required: ['name']
            }
          },
          {
            name: 'add_tracks_to_playlist',
            description: 'Add tracks to a playlist',
            inputSchema: {
              type: 'object',
              properties: {
                playlist_id: {
                  type: 'string',
                  description: 'Spotify playlist ID'
                },
                track_uris: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of Spotify track URIs (spotify:track:...)',
                  maxItems: 100
                }
              },
              required: ['playlist_id', 'track_uris']
            }
          },
          {
            name: 'get_recommendations',
            description: 'Get track recommendations based on seed tracks, artists, or genres',
            inputSchema: {
              type: 'object',
              properties: {
                seed_tracks: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Seed track IDs',
                  maxItems: 5
                },
                seed_artists: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Seed artist IDs',
                  maxItems: 5
                },
                seed_genres: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Seed genre names',
                  maxItems: 5
                },
                limit: {
                  type: 'number',
                  minimum: 1,
                  maximum: 100,
                  default: 20,
                  description: 'Number of recommendations to return'
                },
                target_danceability: { type: 'number', minimum: 0, maximum: 1 },
                target_energy: { type: 'number', minimum: 0, maximum: 1 },
                target_valence: { type: 'number', minimum: 0, maximum: 1 },
                target_tempo: { type: 'number', minimum: 0 }
              }
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'spotify_authenticate':
            return await this.authenticate();
          case 'get_user_profile':
            return await this.getUserProfile();
          case 'get_top_tracks':
            return await this.getTopTracks(args.time_range, args.limit);
          case 'get_top_artists':
            return await this.getTopArtists(args.time_range, args.limit);
          case 'get_recently_played':
            return await this.getRecentlyPlayed(args.limit);
          case 'search_tracks':
            return await this.searchTracks(args.query, args.limit);
          case 'get_track_features':
            return await this.getTrackFeatures(args.track_ids);
          case 'get_playlists':
            return await this.getPlaylists(args.limit);
          case 'get_playlist_tracks':
            return await this.getPlaylistTracks(args.playlist_id, args.limit);
          case 'create_playlist':
            return await this.createPlaylist(args.name, args.description, args.public);
          case 'add_tracks_to_playlist':
            return await this.addTracksToPlaylist(args.playlist_id, args.track_uris);
          case 'get_recommendations':
            return await this.getRecommendations(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`
            }
          ]
        };
      }
    });
  }

  async authenticate() {
    return new Promise((resolve, reject) => {
      const app = express();
      
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
          res.send(`Authentication error: ${error.message}`);
          reject(error);
        }
      });

      const server = app.listen(8888, () => {
        const authUrl = `https://accounts.spotify.com/authorize?` +
          `client_id=${SPOTIFY_CLIENT_ID}&` +
          `response_type=code&` +
          `redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT_URI)}&` +
          `scope=${encodeURIComponent(SCOPES)}`;
        
        console.log('Opening browser for Spotify authentication...');
        open(authUrl);
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
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(profile, null, 2)
        }
      ]
    };
  }

  async getTopTracks(timeRange = 'medium_term', limit = 20) {
    const tracks = await this.makeSpotifyRequest(`/me/top/tracks?time_range=${timeRange}&limit=${limit}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(tracks, null, 2)
        }
      ]
    };
  }

  async getTopArtists(timeRange = 'medium_term', limit = 20) {
    const artists = await this.makeSpotifyRequest(`/me/top/artists?time_range=${timeRange}&limit=${limit}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(artists, null, 2)
        }
      ]
    };
  }

  async getRecentlyPlayed(limit = 20) {
    const tracks = await this.makeSpotifyRequest(`/me/player/recently-played?limit=${limit}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(tracks, null, 2)
        }
      ]
    };
  }

  async searchTracks(query, limit = 20) {
    const results = await this.makeSpotifyRequest(`/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2)
        }
      ]
    };
  }

  async getTrackFeatures(trackIds) {
    const features = await this.makeSpotifyRequest(`/audio-features?ids=${trackIds.join(',')}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(features, null, 2)
        }
      ]
    };
  }

  async getPlaylists(limit = 20) {
    const playlists = await this.makeSpotifyRequest(`/me/playlists?limit=${limit}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(playlists, null, 2)
        }
      ]
    };
  }

  async getPlaylistTracks(playlistId, limit = 50) {
    const tracks = await this.makeSpotifyRequest(`/playlists/${playlistId}/tracks?limit=${limit}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(tracks, null, 2)
        }
      ]
    };
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
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(playlist, null, 2)
        }
      ]
    };
  }

  async addTracksToPlaylist(playlistId, trackUris) {
    const result = await this.makeSpotifyRequest(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      data: {
        uris: trackUris
      }
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  async getRecommendations(params) {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          queryParams.append(key, value.join(','));
        } else {
          queryParams.append(key, value.toString());
        }
      }
    });

    const recommendations = await this.makeSpotifyRequest(`/recommendations?${queryParams.toString()}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(recommendations, null, 2)
        }
      ]
    };
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
