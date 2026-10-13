import React from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import styled, { withTheme } from 'styled-components';
import { getLyrics, hasLyrics } from '../../api/lyric';

// Bounded height so it never fights PlayerInfo (flex:1) for vertical space.
const Container = styled.View`
  height: 170;
  margin-top: 8;
  align-self: stretch;
  align-items: center;
  justify-content: flex-start;
`;

const ScrollWrap = styled(ScrollView)`
  flex: 1;
  align-self: stretch;
`;

const Line = styled(View)`
  padding-vertical: 6;
  padding-horizontal: 8;
  border-radius: 6;
`;

const Origin = styled.Text`
  font-size: ${(props) => (props.active ? 17 : 15)};
  font-weight: ${(props) => (props.active ? 'bold' : 'normal')};
  color: ${(props) => (props.active ? props.theme.primaryColor : props.theme.secondaryColor)};
  text-align: center;
`;

const Sub = styled.Text`
  font-size: 12;
  margin-top: ${(props) => (props.active ? 3 : 1)};
  color: ${(props) => props.theme.secondaryColor};
  opacity: ${(props) => (props.active ? 0.95 : 0.55)};
  text-align: center;
`;

const Tip = styled.Text`
  margin-top: 8;
  font-size: 13;
  color: ${(props) => props.theme.secondaryColor};
  opacity: 0.7;
  text-align: center;
`;

// Find the last line whose time <= current time.
function resolveActiveIndex(lines, current) {
  let idx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time <= current + 0.05) {
      idx = i;
    } else {
      break;
    }
  }
  return idx;
}

class Lyrics extends React.PureComponent {
  props: {
    track: Object,
    current: Number,
    theme: Object,
  };
  constructor(props) {
    super(props);
    this.state = { lines: [], found: false, loading: false, noLyricTag: '' };
    this.scrollRef = React.createRef();
    // Guards against setState on unmounted component and stale responses.
    this.requestSeq = 0;
    this.lastScrolledIndex = -1;
  }

  componentDidMount() {
    this.loadLyrics(this.props.track);
  }

  componentWillReceiveProps(nextProps) {
    if (nextProps.track !== this.props.track) {
      this.loadLyrics(nextProps.track);
    }
  }

  componentWillUnmount() {
    this.requestSeq += 1;
  }

  loadLyrics(track) {
    const seq = this.requestSeq + 1;
    this.requestSeq = seq;
    this.lastScrolledIndex = -1;

    if (!track || !track.title) {
      this.setState({ lines: [], found: false, loading: false, noLyricTag: '请选择歌曲' });
      return;
    }
    this.setState({ loading: true, lines: [], found: false, noLyricTag: '' });
    getLyrics(track).then((res) => {
      if (seq !== this.requestSeq) {
        return; // a newer track was selected meanwhile
      }
      if (!hasLyrics(res)) {
        this.setState({ loading: false, lines: [], found: false, noLyricTag: '暂无歌词' });
        return;
      }
      this.setState({ loading: false, lines: res.lines, found: true });
    });
  }

  scrollToActive(index) {
    if (!this.scrollRef.current) {
      return;
    }
    // Only scroll when the highlighted line actually changes.
    if (index === this.lastScrolledIndex) {
      return;
    }
    this.lastScrolledIndex = index;
    const y = Math.max(0, index * 36 - 70);
    this.scrollRef.current.scrollTo({ y, animated: true });
  }

  componentDidUpdate(prevProps) {
    if (this.props.current !== prevProps.current && this.state.lines.length) {
      const idx = resolveActiveIndex(this.state.lines, this.props.current);
      this.scrollToActive(idx);
    }
  }

  render() {
    const { track, current, theme } = this.props;
    const { lines, found, loading, noLyricTag } = this.state;
    const noTrack = track === null;

    if (loading) {
      return (
        <Container>
          <ActivityIndicator size="small" color={theme.primaryColor} />
        </Container>
      );
    }

    if (!found) {
      return (
        <Container>
          <Tip>{noTrack ? '请选择歌曲' : noLyricTag || '暂无歌词'}</Tip>
        </Container>
      );
    }

    const idx = resolveActiveIndex(lines, current || 0);

    return (
      <Container>
        <ScrollWrap ref={this.scrollRef}>
          <View style={{ paddingBottom: 100 }}>
            {lines.map((line, i) => {
              const active = i === idx;
              return (
                <Line key={`${line.time}-${i}`}>
                  <Origin active={active} theme={theme}>
                    {line.text}
                  </Origin>
                  {line.trans ? (
                    <Sub active={active} theme={theme}>
                      {line.trans}
                    </Sub>
                  ) : null}
                  {line.roma ? (
                    <Sub active={active} theme={theme}>
                      {line.roma}
                    </Sub>
                  ) : null}
                </Line>
              );
            })}
          </View>
        </ScrollWrap>
      </Container>
    );
  }
}

export default withTheme(Lyrics);
